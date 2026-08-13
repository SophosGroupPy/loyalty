/**
 * Auditoría de aislamiento entre productos.
 *
 * Los endpoints scopeados a un comercio ya están cubiertos en api.test.ts. Este
 * archivo persigue los **operativos** —los que no nombran un comercio— que son
 * justamente donde es fácil que se escape el filtro por producto sin que ningún
 * test lo note.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { hashSecret } from "./auth.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");

let db: Db;
let app: FastifyInstance;
let elmenu: string;
let noctu: string;

async function tokenFor(clientId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "client_credentials", client_id: clientId, client_secret: "sec" },
  });
  return res.json().access_token;
}

function as(token: string) {
  return (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload: payload as object } : {}),
    });
}

/** Deja un comercio con una tarjeta y saldo pendiente de sincronizar. */
async function seedProduct(token: string, externalId: string, slug: string) {
  const call = as(token);
  await call("POST", "/v1/merchants", {
    externalId,
    slug,
    legalName: `${slug} SA`,
    displayName: slug,
  });
  await call("PUT", "/v1/programs", {
    merchant: externalId,
    kind: "points",
    config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
  });

  const card = await call("POST", "/v1/memberships", {
    merchant: externalId,
    phone: slug === "bar-z" ? "0993111111" : "0993222222",
    phoneVerified: true,
  });
  const membershipId = card.json().membershipId;

  await call("POST", "/v1/events", {
    merchant: externalId,
    idempotencyKey: `${slug}-1`,
    type: "order.paid",
    amount: 90_000,
    membership: { id: membershipId },
  });

  // Un pase emitido pero desactualizado: es lo que lista pending-sync.
  await rows(
    db.drizzle,
    sql`INSERT INTO pass_instance (membership_id, merchant_id, platform, external_id,
                                   state, last_synced_balance)
        SELECT id, merchant_id, 'google', 'obj-' || ${slug}, 'active', 0
        FROM membership WHERE id = ${membershipId}`,
  );

  return membershipId;
}

beforeEach(async () => {
  db = await createTestDb();
  for (const [slug, cid] of [
    ["elmenu", "cid-elmenu"],
    ["noctu", "cid-noctu"],
  ] as const) {
    await rows(
      db.drizzle,
      sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
          VALUES (${slug}, ${slug}, ${cid}, ${await hashSecret("sec")})`,
    );
  }

  app = createServer({ db, signingKey: SIGNING_KEY });
  await app.ready();

  elmenu = await tokenFor("cid-elmenu");
  noctu = await tokenFor("cid-noctu");
});

afterEach(async () => {
  await app.close();
  await db.close();
});

describe("endpoints operativos", () => {
  it("pending-sync no expone tarjetas de otro producto", async () => {
    const mioElmenu = await seedProduct(elmenu, "r-1", "don-julio");
    const ajenoNoctu = await seedProduct(noctu, "b-1", "bar-z");

    const visto = await as(elmenu)("GET", "/v1/passes/pending-sync");
    expect(visto.statusCode).toBe(200);

    const ids: string[] = visto.json().passes.map((p: { membershipId: string }) => p.membershipId);

    // ElMenu tiene que ver lo suyo…
    expect(ids).toContain(mioElmenu);
    // …y nada de Noctu. Los membershipId son identificadores de clientes de un
    // competidor: filtrarlos permite estimar su volumen de tarjetas activas.
    expect(ids).not.toContain(ajenoNoctu);
  });

  it("un producto ya no puede disparar el despachador global", async () => {
    await seedProduct(elmenu, "r-1", "don-julio");
    await seedProduct(noctu, "b-1", "bar-z");

    // El despachador gasta el cupo de 3 avisos cada 24 h de CADA tarjeta. Con
    // token de producto, ElMenu podía gastar el de los clientes de Noctu.
    const report = await as(elmenu)("POST", "/v1/notifications/dispatch");
    expect(report.statusCode).toBe(404);
  });

  it("la entrega de webhooks no dispara los de otro producto", async () => {
    // El endpoint de Noctu se registra ANTES de generar los eventos: si se
    // registra después no hay entregas pendientes y el test pasaría sin probar
    // nada.
    await as(noctu)("POST", "/v1/webhook-endpoints", { url: "https://noctu.test/hooks" });
    await seedProduct(elmenu, "r-1", "don-julio");
    await seedProduct(noctu, "b-1", "bar-z");

    // Esperamos a que la emisión en segundo plano deje la entrega encolada.
    for (let i = 0; i < 40; i++) {
      const pendientes = await rows<{ count: number }>(
        db.drizzle,
        sql`SELECT count(*)::int AS count FROM webhook_delivery`,
      );
      if ((pendientes[0]?.count ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const encoladas = await rows<{ count: number }>(
      db.drizzle,
      sql`SELECT count(*)::int AS count FROM webhook_delivery d
          JOIN webhook_endpoint e ON e.id = d.endpoint_id
          JOIN product p ON p.id = e.product_id
          WHERE p.slug = 'noctu'`,
    );
    // Precondición: si esto es cero, el test no está probando nada.
    expect(encoladas[0]?.count, "no se encoló ninguna entrega de Noctu").toBeGreaterThan(0);

    const intento = await as(elmenu)("POST", "/v1/webhooks/deliver");
    expect(intento.statusCode).toBe(404);

    const intentadas = await rows<{ count: number }>(
      db.drizzle,
      sql`SELECT count(*)::int AS count FROM webhook_delivery d
          JOIN webhook_endpoint e ON e.id = d.endpoint_id
          JOIN product p ON p.id = e.product_id
          WHERE p.slug = 'noctu' AND d.attempts > 0`,
    );

    // ElMenu no puede consumir los reintentos de Noctu: cada intento fallido
    // acerca la entrega ajena a agotarse.
    expect(intentadas[0]?.count).toBe(0);
  });
});

describe("back-office", () => {
  const ADMIN_KEY = "clave-maestra-de-prueba";

  async function adminToken(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/admin/session",
      payload: { key: ADMIN_KEY, operator: "diego" },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token;
  }

  beforeEach(async () => {
    await app.close();
    app = createServer({ db, signingKey: SIGNING_KEY, adminKey: ADMIN_KEY });
    await app.ready();
    elmenu = await tokenFor("cid-elmenu");
    noctu = await tokenFor("cid-noctu");
  });

  it("rechaza la clave maestra equivocada", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/session",
      payload: { key: "no-es-la-clave", operator: "intruso" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("un token de producto no sirve como sesión de back-office", async () => {
    // Los tres tipos de token los firma la misma clave; lo único que los separa
    // es el issuer. Si esto pasara, cualquier producto vería todo el ecosistema.
    const res = await as(elmenu)("GET", "/admin/overview");
    expect(res.statusCode).toBe(401);
  });

  it("un token de back-office no sirve como token de producto", async () => {
    const res = await as(await adminToken())("GET", "/v1/passes/pending-sync");
    expect(res.statusCode).toBe(401);
  });

  it("ve los dos productos con sus comercios y su pasivo", async () => {
    await seedProduct(elmenu, "r-1", "don-julio");
    await seedProduct(noctu, "b-1", "bar-z");

    const res = await as(await adminToken())("GET", "/admin/overview");
    expect(res.statusCode).toBe(200);

    const products: { slug: string; merchants: number; cards: number; outstanding: number }[] =
      res.json().products;

    expect(products.map((p) => p.slug).sort()).toEqual(["elmenu", "noctu"]);
    for (const p of products) {
      expect(p.merchants).toBe(1);
      expect(p.cards).toBe(1);
      expect(p.outstanding).toBe(9); // 90.000 Gs a 1 punto cada 10.000
    }
  });

  it("mide el grafo de identidad, que es el activo que ningún comercio replica", async () => {
    // La misma persona en un restaurante de ElMenu y en un bar de Noctu.
    await seedProduct(elmenu, "r-1", "don-julio");
    await as(noctu)("POST", "/v1/merchants", {
      externalId: "b-1",
      slug: "bar-z",
      legalName: "Bar Z SA",
      displayName: "Bar Z",
    });
    await as(noctu)("PUT", "/v1/programs", {
      merchant: "b-1",
      kind: "points",
      config: { earn: [{ on: "order.paid", points: 1 }] },
    });
    await as(noctu)("POST", "/v1/memberships", {
      merchant: "b-1",
      phone: "0993222222", // el mismo celular que en don-julio
      phoneVerified: true,
    });

    const res = await as(await adminToken())("GET", "/admin/overview");
    const graph = res.json().identityGraph;

    expect(graph.people).toBe(1);
    expect(graph.multi).toBe(1);
    expect(graph.cross_product).toBe(1);
  });

  it("lista comercios de todo el ecosistema con su producto", async () => {
    await seedProduct(elmenu, "r-1", "don-julio");
    await seedProduct(noctu, "b-1", "bar-z");

    const res = await as(await adminToken())("GET", "/admin/merchants");
    const merchants: { product: string; slug: string }[] = res.json().merchants;

    expect(merchants).toHaveLength(2);
    expect(merchants.map((m) => m.product).sort()).toEqual(["elmenu", "noctu"]);
  });

  it("da de alta un producto y devuelve el secreto una sola vez", async () => {
    const res = await as(await adminToken())("POST", "/admin/products", {
      slug: "eventtra",
      name: "Eventtra",
    });

    expect(res.statusCode).toBe(201);
    const { clientId, clientSecret } = res.json();

    // Y las credenciales tienen que servir de verdad.
    const auth = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret },
    });
    expect(auth.statusCode).toBe(200);
  });

  it("sin clave maestra configurada, el back-office queda deshabilitado", async () => {
    await app.close();
    app = createServer({ db, signingKey: SIGNING_KEY });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/admin/session",
      payload: { key: "cualquiera", operator: "x" },
    });
    expect(res.statusCode).toBe(503);
  });
});
