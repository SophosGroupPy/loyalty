/**
 * Límite de tasa y auditoría de saldos.
 *
 * Los dos son protecciones que solo se notan cuando fallan, así que conviene
 * que los tests describan qué protegen y no solo que "funcionan".
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { hashSecret } from "./auth.js";
import { auditAllBalances } from "./ledger.js";
import { createRateLimiter } from "./rate-limit.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");

let db: Db;
let app: FastifyInstance;
let merchantId: string;
let programId: string;
let personId: string;

async function levantar(rateLimit?: { max: number; windowMs: number }) {
  app = createServer({
    db,
    signingKey: SIGNING_KEY,
    adminKey: "admin-de-test",
    ...(rateLimit ? { rateLimit } : {}),
  });
  await app.ready();
}

beforeEach(async () => {
  db = await createTestDb();

  const [product] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid', ${await hashSecret("sec")}) RETURNING id`,
  );
  const [merchant] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
        VALUES (${product!.id}, 'r-1', 'don-julio', 'Don Julio SA', 'Don Julio') RETURNING id`,
  );
  merchantId = merchant!.id;

  const [person] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO person (phone_e164, consent_version, phone_verified_at)
        VALUES ('+595993427654', 'programa/v1', now()) RETURNING id`,
  );
  personId = person!.id;

  const [program] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO program (merchant_id, kind, config, status)
        VALUES (${merchantId}, 'points',
                ${JSON.stringify({ earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] })}::jsonb,
                'active') RETURNING id`,
  );
  programId = program!.id;
});

afterEach(async () => {
  await app?.close();
  await db.close();
});

const token = async () =>
  (
    await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "client_credentials", client_id: "cid", client_secret: "sec" },
    })
  ).json().access_token;

// ---------------------------------------------------------------------------

describe("ventana deslizante", () => {
  it("deja pasar hasta el tope y después corta", () => {
    let ahora = 1_000_000;
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 }, () => ahora);

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(true);

    const cortado = limiter.check("a");
    expect(cortado.allowed).toBe(false);
    expect(cortado.retryAfterSeconds).toBe(60);
  });

  it("no permite el doble del tope a caballo de la ventana", () => {
    // Es el defecto del contador con reinicio fijo: 3 al final de un minuto y 3
    // al principio del siguiente son 6 en dos segundos. La ventana deslizante
    // lo evita porque mira los últimos 60 segundos, no el minuto calendario.
    let ahora = 1_000_000;
    const limiter = createRateLimiter({ max: 3, windowMs: 60_000 }, () => ahora);

    ahora = 1_059_000; // faltan 1000 ms para cerrar la ventana
    for (let i = 0; i < 3; i++) expect(limiter.check("a").allowed).toBe(true);

    ahora = 1_061_000; // 2 segundos después
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("libera lugar cuando la ventana avanza", () => {
    let ahora = 1_000_000;
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 }, () => ahora);

    limiter.check("a");
    limiter.check("a");
    expect(limiter.check("a").allowed).toBe(false);

    ahora += 60_001;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("cuenta por clave, no globalmente", () => {
    // Un comercio desbocado no puede consumir el cupo de los demás.
    let ahora = 1_000_000;
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 }, () => ahora);

    expect(limiter.check("don-julio").allowed).toBe(true);
    expect(limiter.check("don-julio").allowed).toBe(false);
    expect(limiter.check("bar-z").allowed).toBe(true);
  });
});

describe("límite en la API", () => {
  it("corta las escrituras con 429 y dice cuándo reintentar", async () => {
    await levantar({ max: 2, windowMs: 60_000 });
    const t = await token();

    const evento = (key: string) =>
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${t}` },
        payload: {
          merchant: "r-1",
          type: "order.paid",
          idempotencyKey: key,
          membership: { phone: "0993427654" },
          amount: 10_000,
        },
      });

    await evento("a");
    await evento("b");
    const cortado = await evento("c");

    expect(cortado.statusCode).toBe(429);
    expect(cortado.headers["retry-after"]).toBeTypeOf("string");
    expect(cortado.json().error).toBe("rate_limited");
  });

  it("no limita las lecturas del POS", async () => {
    // Buscar un cliente es barato y es lo que más se usa en una noche cargada.
    // Limitarlo rompería la caja justo cuando hay cola.
    await levantar({ max: 1, windowMs: 60_000 });
    const t = await token();

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/v1/memberships/lookup?merchant=r-1&phone=0993427654",
        headers: { authorization: `Bearer ${t}` },
      });
      expect(res.statusCode).not.toBe(429);
    }
  });

  it("un comercio pasado de vueltas no bloquea a otro", async () => {
    await levantar({ max: 1, windowMs: 60_000 });
    const t = await token();

    await app.inject({
      method: "POST",
      url: "/v1/merchants",
      headers: { authorization: `Bearer ${t}` },
      payload: {
        externalId: "r-2",
        slug: "la-vecina",
        legalName: "La Vecina SRL",
        displayName: "La Vecina",
      },
    });

    // r-1 ya gastó su cupo con el alta de arriba? No: la clave incluye el
    // comercio, y ese request fue de r-2.
    const otro = await app.inject({
      method: "POST",
      url: "/v1/programs",
      headers: { authorization: `Bearer ${t}` },
      payload: { merchant: "r-1", kind: "points", config: { earn: [] } },
    });
    expect(otro.statusCode).not.toBe(429);
  });
});

describe("auditoría de saldos", () => {
  async function tarjeta(serial: string, balance: number) {
    const [m] = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO membership (person_id, program_id, merchant_id, serial_number, balance)
          VALUES (${personId}, ${programId}, ${merchantId}, ${serial}, ${balance}) RETURNING id`,
    );
    return m!.id;
  }

  it("no encuentra nada cuando todo cuadra", async () => {
    await levantar();
    const id = await tarjeta("SN-1", 50);
    await rows(
      db.drizzle,
      sql`INSERT INTO ledger_entry (membership_id, merchant_id, kind, amount, balance_after, business_day)
          VALUES (${id}, ${merchantId}, 'earn', 50, 50, '2026-09-01')`,
    );

    expect(await auditAllBalances(db)).toHaveLength(0);
  });

  it("detecta un saldo escrito por fuera del ledger", async () => {
    // Es el escenario que esta auditoría existe para atrapar: alguien tocó
    // `membership.balance` sin escribir el asiento. Todo sigue funcionando y el
    // número está mal.
    await levantar();
    const id = await tarjeta("SN-2", 50);
    await rows(
      db.drizzle,
      sql`INSERT INTO ledger_entry (membership_id, merchant_id, kind, amount, balance_after, business_day)
          VALUES (${id}, ${merchantId}, 'earn', 50, 50, '2026-09-01')`,
    );
    await rows(db.drizzle, sql`UPDATE membership SET balance = 999 WHERE id = ${id}`);

    const encontradas = await auditAllBalances(db);
    expect(encontradas).toHaveLength(1);
    expect(encontradas[0]).toMatchObject({ serialNumber: "SN-2", stored: 999, computed: 50 });
  });

  it("una tarjeta sin movimientos y sin saldo no es una discrepancia", async () => {
    // Es el estado normal de todo cliente recién dado de alta.
    await levantar();
    await tarjeta("SN-3", 0);
    expect(await auditAllBalances(db)).toHaveLength(0);
  });

  it("el back-office responde ok cuando no hay nada roto", async () => {
    await levantar();
    const sesion = await app.inject({
      method: "POST",
      url: "/admin/session",
      payload: { key: "admin-de-test", operator: "test" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/admin/audit/balances",
      headers: { authorization: `Bearer ${sesion.json().token}` },
    });

    expect(res.json()).toEqual({ ok: true, discrepancies: [] });
  });
});
