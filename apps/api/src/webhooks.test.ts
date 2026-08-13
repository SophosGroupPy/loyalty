/**
 * Entrega de webhooks hacia los productos.
 *
 * Lo que se prueba: que el aviso llegue firmado y verificable, que un producto
 * caído no rompa la venta que disparó el aviso, y que los reintentos no se
 * repitan para siempre.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";
import { verifySignature } from "@sophos/loyalty-sdk";

import { hashSecret } from "./auth.js";
import { createServer } from "./server.js";
import { deliverDue } from "./webhooks.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");

let db: Db;
let app: FastifyInstance;
let token: string;

interface Recorded {
  url: string;
  body: string;
  signature: string | undefined;
  eventType: string | undefined;
}

/** Doble del endpoint del producto. */
function productoFalso(options: { fail?: boolean; status?: number } = {}) {
  const received: Recorded[] = [];

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    received.push({
      url: String(url),
      body: typeof init?.body === "string" ? init.body : "",
      signature: headers.get("x-sophos-signature") ?? undefined,
      eventType: headers.get("x-sophos-event-type") ?? undefined,
    });

    if (options.fail) throw new Error("ECONNREFUSED");
    return new Response("{}", { status: options.status ?? 200 });
  }) as unknown as typeof fetch;

  return { impl, received };
}

function call(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload: payload as object } : {}),
  });
}

/** Comercio con programa, un beneficio de 10 puntos y una tarjeta. */
async function seed(): Promise<string> {
  await call("POST", "/v1/merchants", {
    externalId: "r-1",
    slug: "don-julio",
    legalName: "Don Julio SA",
    displayName: "Don Julio",
  });
  await call("PUT", "/v1/programs", {
    merchant: "r-1",
    kind: "points",
    config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
  });
  await call("POST", "/v1/rewards", { merchant: "r-1", name: "Café gratis", cost: 10 });

  const card = await call("POST", "/v1/memberships", {
    merchant: "r-1",
    phone: "0993427654",
    displayName: "Ana",
    phoneVerified: true,
  });
  return card.json().membershipId;
}

async function registerEndpoint(url = "https://elmenu.test/hooks/loyalty"): Promise<string> {
  const res = await call("POST", "/v1/webhook-endpoints", { url });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().secret;
}

/** Espera a que la emisión en segundo plano aterrice en la base. */
async function waitForDeliveries(expected: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const found = await rows<{ count: number }>(
      db.drizzle,
      sql`SELECT count(*)::int AS count FROM webhook_delivery`,
    );
    if ((found[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeEach(async () => {
  db = await createTestDb();
  await rows(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid', ${await hashSecret("sec")})`,
  );

  app = createServer({ db, signingKey: SIGNING_KEY });
  await app.ready();

  const auth = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "client_credentials", client_id: "cid", client_secret: "sec" },
  });
  token = auth.json().access_token;
});

afterEach(async () => {
  await app.close();
  await db.close();
});

// ---------------------------------------------------------------------------

describe("registro del endpoint", () => {
  it("devuelve el secreto una sola vez y exige HTTPS", async () => {
    const ok = await call("POST", "/v1/webhook-endpoints", {
      url: "https://elmenu.test/hooks",
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().secret).toBeTypeOf("string");

    // El cuerpo lleva teléfonos y saldos: por HTTP viajarían en claro.
    const inseguro = await call("POST", "/v1/webhook-endpoints", {
      url: "http://elmenu.test/hooks",
    });
    expect(inseguro.statusCode).toBe(400);
    expect(inseguro.json().error).toBe("insecure_url");
  });

  it("no duplica el endpoint si se registra la misma URL dos veces", async () => {
    await call("POST", "/v1/webhook-endpoints", { url: "https://elmenu.test/hooks" });
    await call("POST", "/v1/webhook-endpoints", { url: "https://elmenu.test/hooks" });

    const found = await rows<{ count: number }>(
      db.drizzle,
      sql`SELECT count(*)::int AS count FROM webhook_endpoint`,
    );
    expect(found[0]?.count).toBe(1);
  });
});

describe("emisión y entrega", () => {
  it("avisa del cambio de saldo con firma verificable", async () => {
    const secret = await registerEndpoint();
    const membershipId = await seed();

    await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 50_000,
      membership: { id: membershipId },
    });
    await waitForDeliveries(1);

    const fake = productoFalso();
    const report = await deliverDue(db, { fetchImpl: fake.impl });

    expect(report.delivered).toBeGreaterThan(0);

    const entrega = fake.received.find((r) => r.eventType === "membership.balance_changed");
    expect(entrega).toBeDefined();

    // El producto tiene que poder verificarlo con el secreto que recibió.
    expect(verifySignature(entrega!.body, entrega!.signature, secret)).toEqual({ valid: true });

    const cuerpo = JSON.parse(entrega!.body);
    expect(cuerpo.merchant).toBe("r-1"); // su id, no el UUID interno
    expect(cuerpo.data.balance).toBe(5);
    expect(cuerpo.eventId).toBeTypeOf("string");
  });

  it("avisa del beneficio recién desbloqueado, que es el que el cajero necesita", async () => {
    await registerEndpoint();
    const membershipId = await seed();

    await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 120_000,
      membership: { id: membershipId },
    });
    await waitForDeliveries(2);

    const fake = productoFalso();
    await deliverDue(db, { fetchImpl: fake.impl });

    const aviso = fake.received.find((r) => r.eventType === "reward.available");
    expect(aviso).toBeDefined();

    const cuerpo = JSON.parse(aviso!.body);
    expect(cuerpo.data.rewards[0].name).toBe("Café gratis");
    expect(cuerpo.data.balance).toBe(12);
  });

  it("no repite el aviso de beneficio en cada consumo posterior", async () => {
    await registerEndpoint();
    const membershipId = await seed();

    for (const [i, amount] of [120_000, 50_000].entries()) {
      await call("POST", "/v1/events", {
        merchant: "r-1",
        idempotencyKey: `order-${i}`,
        type: "order.paid",
        amount,
        membership: { id: membershipId },
      });
    }
    await waitForDeliveries(3);

    const avisos = await rows<{ count: number }>(
      db.drizzle,
      sql`SELECT count(*)::int AS count FROM webhook_delivery
          WHERE event_type = 'reward.available'`,
    );

    // Solo el cruce del umbral. Repetirlo volvería el aviso ruido y el cajero
    // dejaría de mirarlo.
    expect(avisos[0]?.count).toBe(1);
  });
});

describe("resiliencia", () => {
  it("una caída del producto no rompe la venta", async () => {
    await registerEndpoint();
    const membershipId = await seed();

    const evento = await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 200_000,
      membership: { id: membershipId },
    });

    // Lo esencial: el cliente consumió y sus 20 puntos están registrados,
    // aunque ElMenu no pueda enterarse todavía.
    expect(evento.statusCode).toBe(201);
    expect(evento.json().balance).toBe(20);

    await waitForDeliveries(1);
    const caido = productoFalso({ fail: true });
    const report = await deliverDue(db, { fetchImpl: caido.impl });

    expect(report.delivered).toBe(0);
    expect(report.failed).toBeGreaterThan(0);
  });

  it("reintenta con espera creciente y termina por agotarse", async () => {
    await registerEndpoint();
    const membershipId = await seed();

    await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 50_000,
      membership: { id: membershipId },
    });
    await waitForDeliveries(1);

    const caido = productoFalso({ fail: true });
    let now = new Date();

    // Cinco intentos cubren unas ocho horas. Al sexto ya no se reintenta.
    for (let i = 0; i < 6; i++) {
      await deliverDue(db, { fetchImpl: caido.impl, now });
      now = new Date(now.getTime() + 12 * 60 * 60 * 1000);
    }

    const estado = await rows<{ status: string; attempts: number }>(
      db.drizzle,
      sql`SELECT status, attempts FROM webhook_delivery
          WHERE event_type = 'membership.balance_changed'`,
    );

    expect(estado[0]?.status).toBe("exhausted");
    expect(estado[0]?.attempts).toBe(5);
  });

  it("conserva la entrega agotada para poder explicar qué no llegó", async () => {
    await registerEndpoint();
    const membershipId = await seed();

    await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 50_000,
      membership: { id: membershipId },
    });
    await waitForDeliveries(1);

    const caido = productoFalso({ fail: true });
    await deliverDue(db, { fetchImpl: caido.impl });

    const fallida = await rows<{ last_error: string | null }>(
      db.drizzle,
      sql`SELECT last_error FROM webhook_delivery WHERE status = 'pending'`,
    );

    // Un webhook perdido sin rastro es indistinguible de uno que nunca existió.
    expect(fallida[0]?.last_error).toContain("ECONNREFUSED");
  });

  it("el mismo eventId se mantiene entre reintentos, para poder deduplicar", async () => {
    await registerEndpoint();
    const membershipId = await seed();

    await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 50_000,
      membership: { id: membershipId },
    });
    await waitForDeliveries(1);

    // Primer intento: timeout del lado del producto, que igual lo procesó.
    const lento = productoFalso({ status: 500 });
    await deliverDue(db, { fetchImpl: lento.impl });

    // Segundo intento, ya con el producto sano.
    const sano = productoFalso();
    await deliverDue(db, {
      fetchImpl: sano.impl,
      now: new Date(Date.now() + 10 * 60 * 1000),
    });

    const primero = JSON.parse(lento.received[0]!.body).eventId;
    const segundo = JSON.parse(sano.received[0]!.body).eventId;

    expect(segundo).toBe(primero);
  });
});
