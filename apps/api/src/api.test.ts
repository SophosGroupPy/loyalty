/**
 * Verificación end-to-end de la fase 1, contra los criterios del plan:
 *
 *  1. Reintentar el mismo evento no acumula dos veces.
 *  2. Un producto no puede tocar comercios de otro producto.
 *  3. Un mismo celular en dos comercios = una persona, dos tarjetas que no se
 *     cruzan en ningún punto.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { hashSecret } from "./auth.js";
import { auditBalance } from "./ledger.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("test-signing-key-que-no-va-a-produccion");

let db: Db;
let app: FastifyInstance;

/** Credenciales de los dos productos del v1. */
const PRODUCTS = [
  { slug: "elmenu", name: "ElMenu", clientId: "cid-elmenu", secret: "sec-elmenu" },
  { slug: "noctu", name: "Noctu", clientId: "cid-noctu", secret: "sec-noctu" },
];

beforeEach(async () => {
  db = await createTestDb();

  for (const p of PRODUCTS) {
    await rows(
      db.drizzle,
      sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
          VALUES (${p.slug}, ${p.name}, ${p.clientId}, ${await hashSecret(p.secret)})`,
    );
  }

  app = createServer({ db, signingKey: SIGNING_KEY });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tokenFor(slug: string): Promise<string> {
  const product = PRODUCTS.find((p) => p.slug === slug)!;
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: product.clientId,
      client_secret: product.secret,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().access_token;
}

function call(
  token: string,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload: payload as object } : {}),
  });
}

/** Comercio con programa de puntos: 1 punto cada 10.000 Gs. */
async function setupMerchant(
  token: string,
  externalId: string,
  slug: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await call(token, "POST", "/v1/merchants", {
    externalId,
    slug,
    legalName: `${slug} SA`,
    displayName: slug,
  });
  expect(created.statusCode, created.body).toBe(200);

  const program = await call(token, "PUT", "/v1/programs", {
    merchant: externalId,
    kind: "points",
    config: {
      earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }],
      ...overrides,
    },
  });
  expect(program.statusCode, program.body).toBe(200);

  return externalId;
}

async function enroll(token: string, merchant: string, phone: string, name?: string) {
  const res = await call(token, "POST", "/v1/memberships", {
    merchant,
    phone,
    ...(name ? { displayName: name } : {}),
    phoneVerified: true,
  });
  expect([200, 201], res.body).toContain(res.statusCode);
  return res.json();
}

// ---------------------------------------------------------------------------
// 1. Idempotencia
// ---------------------------------------------------------------------------

describe("idempotencia de la ingesta", () => {
  it("acumula una sola vez aunque el mismo evento llegue tres veces", async () => {
    const token = await tokenFor("elmenu");
    await setupMerchant(token, "r-1", "don-julio");
    const card = await enroll(token, "r-1", "0993427654");

    const send = () =>
      call(token, "POST", "/v1/events", {
        merchant: "r-1",
        idempotencyKey: "order-4271",
        type: "order.paid",
        amount: 85_000,
        membership: { id: card.membershipId },
      });

    const first = await send();
    const second = await send();
    const third = await send();

    expect(first.statusCode).toBe(201);
    expect(first.json().duplicate).toBe(false);
    expect(first.json().amount).toBe(8);

    // Los reintentos devuelven el resultado del primero, sin volver a acumular.
    for (const retry of [second, third]) {
      expect(retry.statusCode).toBe(200);
      expect(retry.json().duplicate).toBe(true);
      expect(retry.json().balance).toBe(8);
    }

    const entries = await rows<{ count: string }>(
      db.drizzle,
      sql`SELECT count(*)::text AS count FROM ledger_entry
          WHERE membership_id = ${card.membershipId}`,
    );
    expect(entries[0]?.count).toBe("1");

    expect(await auditBalance(db, card.membershipId)).toMatchObject({
      stored: 8,
      computed: 8,
      consistent: true,
    });
  });

  it("distingue pedidos distintos del mismo comercio", async () => {
    const token = await tokenFor("elmenu");
    await setupMerchant(token, "r-1", "don-julio");
    const card = await enroll(token, "r-1", "0993427654");

    for (const key of ["order-1", "order-2"]) {
      const res = await call(token, "POST", "/v1/events", {
        merchant: "r-1",
        idempotencyKey: key,
        type: "order.paid",
        amount: 50_000,
        membership: { id: card.membershipId },
      });
      expect(res.statusCode).toBe(201);
    }

    expect(await auditBalance(db, card.membershipId)).toMatchObject({
      stored: 10,
      consistent: true,
    });
  });

  it("deja rastro del evento aunque el tope diario lo deje en cero", async () => {
    const token = await tokenFor("elmenu");
    await setupMerchant(token, "r-1", "don-julio", { caps: { perDay: 5 } });
    const card = await enroll(token, "r-1", "0993427654");

    const send = (key: string) =>
      call(token, "POST", "/v1/events", {
        merchant: "r-1",
        idempotencyKey: key,
        type: "order.paid",
        amount: 100_000,
        membership: { id: card.membershipId },
      });

    const first = await send("a");
    const second = await send("b");

    expect(first.json().amount).toBe(5);
    expect(first.json().trace.cappedBy).toBe("per_day");

    // El segundo no genera asiento, pero sí queda registrado el porqué.
    expect(second.json().amount).toBe(0);
    expect(second.json().skipped).toBe("zero_amount");

    const stored = await rows<{ result: { trace: { cappedBy: string } } }>(
      db.drizzle,
      sql`SELECT result FROM event WHERE idempotency_key = 'b'`,
    );
    expect(stored[0]?.result.trace.cappedBy).toBe("per_day");
  });
});

// ---------------------------------------------------------------------------
// 2. Aislamiento entre productos y entre comercios
// ---------------------------------------------------------------------------

describe("aislamiento", () => {
  it("un token de ElMenu no alcanza comercios de Noctu", async () => {
    const elmenu = await tokenFor("elmenu");
    const noctu = await tokenFor("noctu");

    await setupMerchant(noctu, "bar-9", "bar-z");

    const res = await call(elmenu, "GET", "/v1/memberships/lookup?merchant=bar-9&phone=0993427654");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("tampoco alcanza con el UUID interno del comercio ajeno", async () => {
    const elmenu = await tokenFor("elmenu");
    const noctu = await tokenFor("noctu");

    await setupMerchant(noctu, "bar-9", "bar-z");
    const uuid = (
      await rows<{ id: string }>(
        db.drizzle,
        sql`SELECT id FROM merchant WHERE external_id = 'bar-9'`,
      )
    )[0]!.id;

    // Conocer el identificador interno no habilita nada: el producto siempre
    // entra en el WHERE que resuelve el comercio.
    const res = await call(elmenu, "POST", "/v1/events", {
      merchant: uuid,
      idempotencyKey: "x",
      type: "order.paid",
      amount: 10_000,
      membership: { phone: "0993427654" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("un comercio no ve los clientes de otro comercio del mismo producto", async () => {
    const elmenu = await tokenFor("elmenu");
    await setupMerchant(elmenu, "r-1", "don-julio");
    await setupMerchant(elmenu, "r-2", "la-cabrera");

    await enroll(elmenu, "r-1", "0993427654", "Ana");

    // ElMenu es el integrador de los dos, pero la consulta está acotada al
    // comercio: la clienta de Don Julio no aparece en La Cabrera.
    const otro = await call(
      elmenu,
      "GET",
      "/v1/memberships/lookup?merchant=r-2&phone=0993427654",
    );
    expect(otro.statusCode).toBe(404);

    const propio = await call(
      elmenu,
      "GET",
      "/v1/memberships/lookup?merchant=r-1&phone=0993427654",
    );
    expect(propio.statusCode).toBe(200);
    expect(propio.json().displayName).toBe("Ana");
  });

  it("rechaza pedidos sin token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/memberships/lookup?merchant=r-1&phone=0993427654",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rechaza credenciales inválidas", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: {
        grant_type: "client_credentials",
        client_id: "cid-elmenu",
        client_secret: "no-es-el-secreto",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 3. Identidad compartida, programas separados
// ---------------------------------------------------------------------------

describe("identidad compartida con programas separados", () => {
  it("un mismo celular da una persona y dos tarjetas que no se cruzan", async () => {
    const elmenu = await tokenFor("elmenu");
    const noctu = await tokenFor("noctu");

    await setupMerchant(elmenu, "r-1", "don-julio");
    await setupMerchant(noctu, "bar-9", "bar-z");

    // El mismo número escrito de dos formas distintas: tiene que resolver a la
    // misma persona, o el alta de un toque no funciona nunca.
    const enRestaurante = await enroll(elmenu, "r-1", "0993427654", "Ana");
    const enBar = await enroll(noctu, "bar-9", "+595 993 427654", "Ana G.");

    expect(enBar.personExisted).toBe(true);
    expect(enBar.personId).toBe(enRestaurante.personId);
    expect(enBar.membershipId).not.toBe(enRestaurante.membershipId);
    expect(enBar.serialNumber).not.toBe(enRestaurante.serialNumber);

    const people = await rows<{ count: string }>(
      db.drizzle,
      sql`SELECT count(*)::text AS count FROM person`,
    );
    expect(people[0]?.count).toBe("1");

    // Acumula solo en el restaurante.
    await call(elmenu, "POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 200_000,
      membership: { id: enRestaurante.membershipId },
    });

    const enElRestaurante = await call(
      elmenu,
      "GET",
      "/v1/memberships/lookup?merchant=r-1&phone=0993427654",
    );
    const enElBar = await call(
      noctu,
      "GET",
      "/v1/memberships/lookup?merchant=bar-9&phone=0993427654",
    );

    expect(enElRestaurante.json().balance).toBe(20);
    // El saldo del bar sigue en cero: no hay puntos compartidos ni programa global.
    expect(enElBar.json().balance).toBe(0);

    // Y cada comercio administra su propia ficha del cliente.
    expect(enElRestaurante.json().displayName).toBe("Ana");
    expect(enElBar.json().displayName).toBe("Ana G.");
  });

  it("el beneficio de un comercio no se puede canjear en otro", async () => {
    const elmenu = await tokenFor("elmenu");
    const noctu = await tokenFor("noctu");

    await setupMerchant(elmenu, "r-1", "don-julio");
    await setupMerchant(noctu, "bar-9", "bar-z");

    const enRestaurante = await enroll(elmenu, "r-1", "0993427654");
    const enBar = await enroll(noctu, "bar-9", "0993427654");

    const reward = await call(elmenu, "POST", "/v1/rewards", {
      merchant: "r-1",
      name: "Café gratis",
      cost: 10,
    });
    const rewardId = reward.json().id;

    // Ana junta puntos de sobra en los dos lados.
    for (const [token, merchant, membershipId] of [
      [elmenu, "r-1", enRestaurante.membershipId],
      [noctu, "bar-9", enBar.membershipId],
    ] as const) {
      await call(token, "POST", "/v1/events", {
        merchant,
        idempotencyKey: `order-${merchant}`,
        type: "order.paid",
        amount: 500_000,
        membership: { id: membershipId },
      });
    }

    const cruzado = await call(noctu, "POST", "/v1/redemptions", {
      merchant: "bar-9",
      rewardId,
      membership: { id: enBar.membershipId },
      redeemedBy: "staff:1",
    });
    expect(cruzado.statusCode).toBe(404);
    expect(cruzado.json().error).toBe("reward_not_found");

    const propio = await call(elmenu, "POST", "/v1/redemptions", {
      merchant: "r-1",
      rewardId,
      membership: { id: enRestaurante.membershipId },
      redeemedBy: "staff:1",
    });
    expect(propio.statusCode, propio.body).toBe(201);
    expect(propio.json().balance).toBe(40);

    expect(await auditBalance(db, enRestaurante.membershipId)).toMatchObject({
      consistent: true,
    });
    // Canjear en un lado no toca el saldo del otro.
    expect(await auditBalance(db, enBar.membershipId)).toMatchObject({
      stored: 50,
      consistent: true,
    });
  });

  it("no deja canjear sin saldo suficiente", async () => {
    const elmenu = await tokenFor("elmenu");
    await setupMerchant(elmenu, "r-1", "don-julio");
    const card = await enroll(elmenu, "r-1", "0993427654");

    const reward = await call(elmenu, "POST", "/v1/rewards", {
      merchant: "r-1",
      name: "Café gratis",
      cost: 10,
    });

    const res = await call(elmenu, "POST", "/v1/redemptions", {
      merchant: "r-1",
      rewardId: reward.json().id,
      membership: { id: card.membershipId },
      redeemedBy: "staff:1",
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_balance");
    expect(res.json().required).toBe(10);
  });

  it("el alta es idempotente dentro del mismo comercio", async () => {
    const elmenu = await tokenFor("elmenu");
    await setupMerchant(elmenu, "r-1", "don-julio");

    const first = await enroll(elmenu, "r-1", "0993427654");
    const second = await enroll(elmenu, "r-1", "993427654");

    expect(second.created).toBe(false);
    expect(second.membershipId).toBe(first.membershipId);
  });
});

// ---------------------------------------------------------------------------
// El aviso al POS, que es lo que hace útil la fase 1 sin ninguna wallet
// ---------------------------------------------------------------------------

describe("aviso al POS", () => {
  it("informa los beneficios que el cliente ya puede canjear", async () => {
    const elmenu = await tokenFor("elmenu");
    await setupMerchant(elmenu, "r-1", "don-julio");
    const card = await enroll(elmenu, "r-1", "0993427654");

    await call(elmenu, "POST", "/v1/rewards", {
      merchant: "r-1",
      name: "Café gratis",
      cost: 10,
    });
    await call(elmenu, "POST", "/v1/rewards", {
      merchant: "r-1",
      name: "Almuerzo gratis",
      cost: 100,
    });

    await call(elmenu, "POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 150_000,
      membership: { id: card.membershipId },
    });

    const res = await call(
      elmenu,
      "GET",
      "/v1/memberships/lookup?merchant=r-1&phone=0993427654",
    );

    // Con 15 puntos alcanza para el café pero no para el almuerzo. El cajero ve
    // exactamente eso al buscar al cliente, sin depender de ninguna notificación.
    expect(res.json().balance).toBe(15);
    expect(res.json().availableRewards).toEqual([
      { id: expect.any(String), name: "Café gratis", cost: 10 },
    ]);
  });
});
