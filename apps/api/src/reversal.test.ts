/**
 * Reversa de una acumulación.
 *
 * El caso que define esta pieza no es el feliz: es qué pasa cuando el cliente
 * ya canjeó los puntos que hay que devolver. No se puede des-tomar el café, y
 * dejar el saldo en negativo violaría el invariante de la tarjeta.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { hashSecret } from "./auth.js";
import { auditBalance } from "./ledger.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");

let db: Db;
let app: FastifyInstance;
let elmenu: string;
let noctu: string;
let serial: string;
let membershipId: string;

async function token(clientId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "client_credentials", client_id: clientId, client_secret: "sec" },
  });
  return res.json().access_token;
}

const como = (t: string) => (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${t}` },
    ...(payload ? { payload: payload as object } : {}),
  });

/** Un consumo de 120.000 guaraníes: 12 puntos con la regla sembrada. */
const consumo = (key: string, amount = 120_000) => ({
  merchant: "r-1",
  type: "order.paid" as const,
  idempotencyKey: key,
  membership: { serial },
  amount,
});

beforeEach(async () => {
  db = await createTestDb();
  app = createServer({ db, signingKey: SIGNING_KEY });
  await app.ready();

  for (const [slug, cid] of [["elmenu", "cid-elmenu"], ["noctu", "cid-noctu"]] as const) {
    await rows(
      db.drizzle,
      sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
          VALUES (${slug}, ${slug}, ${cid}, ${await hashSecret("sec")})`,
    );
  }
  elmenu = await token("cid-elmenu");
  noctu = await token("cid-noctu");

  await como(elmenu)("POST", "/v1/merchants", {
    externalId: "r-1", slug: "la-vecina", legalName: "La Vecina SRL", displayName: "La Vecina",
  });
  await como(elmenu)("PUT", "/v1/programs", {
    merchant: "r-1", kind: "points",
    config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
  });

  const alta = await como(elmenu)("POST", "/v1/memberships", {
    merchant: "r-1", phone: "0993427654", displayName: "Ana",
  });
  serial = alta.json().serialNumber;
  membershipId = alta.json().membershipId;
});

afterEach(async () => {
  await app.close();
  await db.close();
});

const revertir = (key: string, t = elmenu) =>
  como(t)("POST", "/v1/events/reverse", { merchant: "r-1", idempotencyKey: key });

const saldo = async () =>
  (await rows<{ balance: number }>(
    db.drizzle, sql`SELECT balance FROM membership WHERE id = ${membershipId}`,
  ))[0]!.balance;

// ---------------------------------------------------------------------------

describe("deshacer un consumo", () => {
  it("descuenta lo acumulado y deja el saldo como estaba", async () => {
    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));
    expect(await saldo()).toBe(12);

    const res = await revertir("pedido-1");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reversed: 12, notRecovered: 0, balance: 0 });
    expect(await saldo()).toBe(0);
  });

  it("no borra nada: la acumulación original queda en el historial", async () => {
    // El ledger es append-only. Borrar el asiento haría imposible explicar un
    // reclamo del cliente.
    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));
    await revertir("pedido-1");

    const asientos = await rows<{ kind: string; amount: number }>(
      db.drizzle,
      sql`SELECT kind, amount FROM ledger_entry WHERE membership_id = ${membershipId}
          ORDER BY created_at`,
    );
    expect(asientos).toEqual([
      { kind: "earn", amount: 12 },
      { kind: "adjust", amount: -12 },
    ]);
  });

  it("deja el saldo cuadrado contra el ledger", async () => {
    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));
    await revertir("pedido-1");

    expect((await auditBalance(db, membershipId)).consistent).toBe(true);
  });
});

describe("cuando el cliente ya gastó los puntos", () => {
  async function canjearTodo() {
    const r = await como(elmenu)("POST", "/v1/rewards", {
      merchant: "r-1", name: "Café gratis", cost: 12,
    });
    await como(elmenu)("POST", "/v1/redemptions", {
      merchant: "r-1", membership: { serial }, rewardId: r.json().id, redeemedBy: "caja-1",
    });
  }

  it("descuenta lo que hay y avisa cuánto no se pudo recuperar", async () => {
    // No se puede des-tomar el café. Dejar el saldo en negativo violaría el
    // invariante de la tarjeta y sería incomprensible para el cliente.
    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));
    await canjearTodo();
    expect(await saldo()).toBe(0);

    const res = await revertir("pedido-1");

    expect(res.json()).toMatchObject({ reversed: 0, notRecovered: 12, balance: 0 });
    expect(await saldo()).toBe(0);
  });

  it("con saldo parcial, descuenta hasta donde llega", async () => {
    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));   // +12
    await canjearTodo();                                              // -12 → 0
    await como(elmenu)("POST", "/v1/events", consumo("pedido-2", 50_000)); // +5
    expect(await saldo()).toBe(5);

    const res = await revertir("pedido-1");

    // De los 12 originales solo quedaban 5 recuperables.
    expect(res.json()).toMatchObject({ reversed: 5, notRecovered: 7, balance: 0 });
  });

  it("nunca deja el saldo en negativo", async () => {
    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));
    await canjearTodo();
    await revertir("pedido-1");

    expect(await saldo()).toBeGreaterThanOrEqual(0);
  });
});

describe("reintentos y bordes", () => {
  it("revertir dos veces no descuenta dos veces", async () => {
    // El producto de origen puede reintentar: su cola de salida no sabe si el
    // primer intento llegó.
    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));
    await revertir("pedido-1");
    const segunda = await revertir("pedido-1");

    expect(segunda.json()).toMatchObject({ reversed: 12, duplicate: true });
    expect(await saldo()).toBe(0);
  });

  it("404 si no hay un consumo con esa clave", async () => {
    expect((await revertir("no-existe")).statusCode).toBe(404);
  });

  it("un consumo que no sumó puntos no es un error", async () => {
    // Pasa cuando el monto no llega al mínimo para sumar: el evento existe pero
    // no generó asiento.
    await como(elmenu)("POST", "/v1/events", consumo("pedido-chico", 500));
    expect(await saldo()).toBe(0);

    const res = await revertir("pedido-chico");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ nothingToReverse: true });
  });

  it("un producto no puede revertir el consumo de otro", async () => {
    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));

    expect((await revertir("pedido-1", noctu)).statusCode).toBe(403);
    expect(await saldo()).toBe(12);
  });
});

describe("el nivel se recalcula", () => {
  it("bajar de saldo puede bajar de nivel", async () => {
    // El programa con niveles va antes del alta: PUT /v1/programs crea uno
    // nuevo, y una membresía ya emitida sigue apuntando al anterior.
    await como(elmenu)("PUT", "/v1/programs", {
      merchant: "r-1", kind: "points",
      config: {
        earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }],
        tiers: [{ name: "Plata", min: 10 }],
      },
    });
    const alta = await como(elmenu)("POST", "/v1/memberships", {
      merchant: "r-1", phone: "0991111111", displayName: "Beto",
    });
    serial = alta.json().serialNumber;
    membershipId = alta.json().membershipId;

    await como(elmenu)("POST", "/v1/events", consumo("pedido-1"));
    const [antes] = await rows<{ tier: string | null }>(
      db.drizzle, sql`SELECT tier FROM membership WHERE id = ${membershipId}`,
    );
    expect(antes!.tier).toBe("Plata");

    await revertir("pedido-1");

    const [despues] = await rows<{ tier: string | null }>(
      db.drizzle, sql`SELECT tier FROM membership WHERE id = ${membershipId}`,
    );
    expect(despues!.tier).toBeNull();
  });
});
