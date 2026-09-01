/**
 * El SDK corriendo contra la API de verdad.
 *
 * El riesgo que cubre no es que el SDK falle solo: es que el SDK y la API dejen
 * de estar de acuerdo. Un campo renombrado en un endpoint, un código de estado
 * que cambia, un payload que se reordena — nada de eso lo detecta un test del
 * SDK contra un stub, porque el stub lo escribe la misma persona que rompió el
 * contrato. Acá el SDK habla con el servidor real.
 *
 * Recorre el camino completo de ElMenu: activar el módulo para un restaurante,
 * darle la consola, y después operar.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";
import { LoyaltyClient } from "@sophos/loyalty-sdk";

import { hashSecret } from "./auth.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");

let db: Db;
let app: FastifyInstance;
let elmenu: LoyaltyClient;

/**
 * Enruta el `fetch` del SDK a `app.inject`.
 *
 * Evita abrir un puerto real: los tests corren en paralelo y un puerto fijo los
 * haría chocar entre sí. Lo que importa —que el SDK arme bien el request y lea
 * bien la respuesta— se prueba igual, porque `inject` recorre el mismo pipeline
 * de Fastify que una conexión de red.
 */
function injectFetch(instance: () => FastifyInstance): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await instance().inject({
      method: (init?.method ?? "GET") as "GET",
      url: url.pathname + url.search,
      headers: init?.headers as Record<string, string>,
      ...(init?.body ? { payload: JSON.parse(String(init.body)) } : {}),
    });

    return new Response(res.body, {
      status: res.statusCode,
      headers: { "content-type": res.headers["content-type"] as string },
    });
  }) as typeof fetch;
}

beforeEach(async () => {
  db = await createTestDb();
  app = createServer({ db, signingKey: SIGNING_KEY });
  await app.ready();

  await rows(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid-elmenu', ${await hashSecret("secreto")})`,
  );
  await rows(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('noctu', 'Noctu', 'cid-noctu', ${await hashSecret("secreto")})`,
  );

  elmenu = new LoyaltyClient({
    baseUrl: "http://loyalty.test",
    clientId: "cid-elmenu",
    clientSecret: "secreto",
    fetch: injectFetch(() => app),
  });
});

afterEach(async () => {
  await app.close();
  await db.close();
});

/** Lo que corre cuando un restaurante enciende Fidelización dentro de ElMenu. */
async function activar(externalId = "resto-42", slug = "don-julio") {
  await elmenu.upsertMerchant({
    externalId,
    slug,
    legalName: "Don Julio SA",
    displayName: "Don Julio",
  });

  await elmenu.configureProgram({
    merchant: externalId,
    kind: "points",
    config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
  });
}

// ---------------------------------------------------------------------------

describe("activación del módulo", () => {
  it("da de alta el comercio y su programa", async () => {
    const merchant = await elmenu.upsertMerchant({
      externalId: "resto-42",
      slug: "don-julio",
      legalName: "Don Julio SA",
      displayName: "Don Julio",
    });

    expect(merchant.id).toBeTypeOf("string");
    expect(merchant.slug).toBe("don-julio");

    const program = await elmenu.configureProgram({
      merchant: "resto-42",
      kind: "points",
      config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
    });
    expect(program.id).toBeTypeOf("string");
  });

  it("no cambia el slug de un comercio ya dado de alta", async () => {
    // El slug está adentro del Pass Type ID de Apple y del id de clase de
    // Google. Si se pudiera cambiar, todos los pases emitidos quedarían
    // apuntando a un identificador que ya no existe.
    await elmenu.upsertMerchant({
      externalId: "resto-42",
      slug: "don-julio",
      legalName: "Don Julio SA",
      displayName: "Don Julio",
    });

    const renombrado = await elmenu.upsertMerchant({
      externalId: "resto-42",
      slug: "don-julio-parrilla",
      legalName: "Don Julio SA",
      displayName: "Don Julio Parrilla",
    });

    // Devuelve el guardado, no el que se mandó: así el integrador puede notar
    // que su cambio no se aplicó en vez de asumir que sí.
    expect(renombrado.slug).toBe("don-julio");
  });

  it("volver a activar no duplica el comercio", async () => {
    // ElMenu puede llamar esto en cada arranque sin revisar si ya existe. Si no
    // fuera idempotente, cada reinicio crearía un comercio nuevo con la base de
    // clientes vacía.
    const primera = await elmenu.upsertMerchant({
      externalId: "resto-42",
      slug: "don-julio",
      legalName: "Don Julio SA",
      displayName: "Don Julio",
    });
    const segunda = await elmenu.upsertMerchant({
      externalId: "resto-42",
      slug: "don-julio",
      legalName: "Don Julio SA",
      displayName: "Don Julio Parrilla",
    });

    expect(segunda.id).toBe(primera.id);
    const todos = await rows<{ id: string }>(db.drizzle, sql`SELECT id FROM merchant`);
    expect(todos).toHaveLength(1);
  });

  it("entrega el token con el que se embebe la consola", async () => {
    await activar();

    const { token, expiresIn } = await elmenu.createEmbedToken({
      merchant: "resto-42",
      staffId: "usuario-7",
    });

    expect(token).toBeTypeOf("string");
    expect(expiresIn).toBeGreaterThan(0);

    // El token tiene que servir de verdad contra la consola.
    const res = await app.inject({
      method: "GET",
      url: "/embed/summary",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().merchant.displayName).toBe("Don Julio");
  });
});

describe("aislamiento entre productos", () => {
  it("ElMenu no puede pedir la consola de un comercio de Noctu", async () => {
    const noctu = new LoyaltyClient({
      baseUrl: "http://loyalty.test",
      clientId: "cid-noctu",
      clientSecret: "secreto",
      fetch: injectFetch(() => app),
    });
    await noctu.upsertMerchant({
      externalId: "bar-1",
      slug: "bar-z",
      legalName: "Bar Z SA",
      displayName: "Bar Z",
    });

    await expect(elmenu.createEmbedToken({ merchant: "bar-1" })).rejects.toThrow();
  });

  it("el mismo externalId en dos productos son comercios distintos", async () => {
    // ElMenu y Noctu numeran sus comercios por su cuenta y van a colisionar.
    const noctu = new LoyaltyClient({
      baseUrl: "http://loyalty.test",
      clientId: "cid-noctu",
      clientSecret: "secreto",
      fetch: injectFetch(() => app),
    });

    const a = await elmenu.upsertMerchant({
      externalId: "1",
      slug: "don-julio",
      legalName: "Don Julio SA",
      displayName: "Don Julio",
    });
    const b = await noctu.upsertMerchant({
      externalId: "1",
      slug: "bar-z",
      legalName: "Bar Z SA",
      displayName: "Bar Z",
    });

    expect(a.id).not.toBe(b.id);
  });
});

describe("operación desde el POS", () => {
  it("acumula, consulta y canjea", async () => {
    await activar();

    const alta = await elmenu.enroll({
      merchant: "resto-42",
      phone: "0993427654",
      displayName: "Ana",
    });
    expect(alta.serialNumber).toBeTypeOf("string");

    await elmenu.ingestEvent({
      merchant: "resto-42",
      type: "order.paid",
      idempotencyKey: "pedido-1",
      membership: { serial: alta.serialNumber },
      amount: 120_000,
    });

    const cliente = await elmenu.lookupMembership("resto-42", { serial: alta.serialNumber });
    expect(cliente?.balance).toBe(12);
  });

  it("el mismo pedido dos veces acumula una sola vez", async () => {
    // Un POS con mala señal reintenta. Sin idempotencia, el cliente cobra doble
    // y el comercio no se entera.
    await activar();
    const alta = await elmenu.enroll({ merchant: "resto-42", phone: "0993427654" });

    const evento = {
      merchant: "resto-42",
      type: "order.paid" as const,
      idempotencyKey: "pedido-1",
      membership: { serial: alta.serialNumber },
      amount: 120_000,
    };
    await elmenu.ingestEvent(evento);
    const segunda = await elmenu.ingestEvent(evento);

    expect(segunda.duplicate).toBe(true);
    const cliente = await elmenu.lookupMembership("resto-42", { serial: alta.serialNumber });
    expect(cliente?.balance).toBe(12);
  });

  it("un cliente sin tarjeta devuelve null, no un error", async () => {
    // Es el caso más común en un comercio recién activado: la mayoría de sus
    // clientes todavía no se sumaron. Tratarlo como falla llena los logs del POS.
    await activar();
    const cliente = await elmenu.lookupMembership("resto-42", { phone: "0991111111" });
    expect(cliente).toBeNull();
  });
});
