/**
 * Consola embebible: emisión del token y aislamiento.
 *
 * Lo que se prueba acá no es la UI sino la propiedad de la que depende todo el
 * modelo: **un comercio no puede alcanzar los datos de otro por más que edite
 * el request**. Si eso falla, el módulo no se puede vender.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { hashSecret, issueEmbedToken, verifyEmbedToken, verifyToken } from "./auth.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");

let db: Db;
let app: FastifyInstance;
let elmenuToken: string;
let noctuToken: string;

/** Access token de producto por client_credentials. */
async function productToken(clientId: string, secret: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "client_credentials", client_id: clientId, client_secret: secret },
  });
  return res.json().access_token;
}

function asProduct(token: string) {
  return (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload: payload as object } : {}),
    });
}

function asEmbed(token: string) {
  return (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload: payload as object } : {}),
    });
}

beforeEach(async () => {
  db = await createTestDb();

  for (const [slug, name, cid] of [
    ["elmenu", "ElMenu", "cid-elmenu"],
    ["noctu", "Noctu", "cid-noctu"],
  ] as const) {
    await rows(
      db.drizzle,
      sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
          VALUES (${slug}, ${name}, ${cid}, ${await hashSecret("sec")})`,
    );
  }

  app = createServer({ db, signingKey: SIGNING_KEY });
  await app.ready();

  elmenuToken = await productToken("cid-elmenu", "sec");
  noctuToken = await productToken("cid-noctu", "sec");

  // Un restaurante en ElMenu, otro restaurante en ElMenu, y un bar en Noctu.
  const elmenu = asProduct(elmenuToken);
  await elmenu("POST", "/v1/merchants", {
    externalId: "r-1",
    slug: "don-julio",
    legalName: "Don Julio SA",
    displayName: "Don Julio",
  });
  await elmenu("POST", "/v1/merchants", {
    externalId: "r-2",
    slug: "la-vecina",
    legalName: "La Vecina SRL",
    displayName: "La Vecina",
  });
  await elmenu("PUT", "/v1/programs", {
    merchant: "r-1",
    kind: "points",
    config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
  });

  await asProduct(noctuToken)("POST", "/v1/merchants", {
    externalId: "b-1",
    slug: "bar-z",
    legalName: "Bar Z SA",
    displayName: "Bar Z",
  });
});

afterEach(async () => {
  await app.close();
  await db.close();
});

// ---------------------------------------------------------------------------

describe("emisión del token", () => {
  it("un producto emite token para su propio comercio", async () => {
    const res = await asProduct(elmenuToken)("POST", "/v1/embed-tokens", { merchant: "r-1" });

    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe("Don Julio");
    expect(res.json().token).toBeTypeOf("string");
  });

  it("un producto NO puede emitir token para el comercio de otro producto", async () => {
    // ElMenu pidiendo la consola de un bar de Noctu.
    const res = await asProduct(elmenuToken)("POST", "/v1/embed-tokens", { merchant: "b-1" });
    expect(res.statusCode).toBe(403);
  });

  it("exige access token de producto", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/embed-tokens",
      payload: { merchant: "r-1" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("separación entre tipos de token", () => {
  it("un access token de producto no sirve como token de consola", async () => {
    // Los emite el mismo servidor con la misma clave: lo único que los separa
    // es el issuer. Si esto pasara, cualquier producto vería cualquier comercio.
    const res = await asEmbed(elmenuToken)("GET", "/embed/summary");
    expect(res.statusCode).toBe(401);
  });

  it("un token de consola no sirve como access token de producto", async () => {
    const minted = await asProduct(elmenuToken)("POST", "/v1/embed-tokens", { merchant: "r-1" });
    const embedToken = minted.json().token;

    const res = await asProduct(embedToken)("GET", "/v1/passes/pending-sync");
    expect(res.statusCode).toBe(401);
  });

  it("verifyToken y verifyEmbedToken se rechazan mutuamente", async () => {
    const { token } = await issueEmbedToken(SIGNING_KEY, {
      merchantId: "00000000-0000-0000-0000-000000000000",
      productId: "p",
    });

    expect(await verifyToken(SIGNING_KEY, token)).toBeNull();
    expect(await verifyEmbedToken(SIGNING_KEY, elmenuToken)).toBeNull();
  });

  it("rechaza un token firmado con otra clave", async () => {
    const { token } = await issueEmbedToken(
      new TextEncoder().encode("otra-clave-completamente-distinta"),
      { merchantId: "x", productId: "p" },
    );

    expect(await verifyEmbedToken(SIGNING_KEY, token)).toBeNull();
  });
});

describe("aislamiento de la sesión de consola", () => {
  let donJulio: string;

  beforeEach(async () => {
    const minted = await asProduct(elmenuToken)("POST", "/v1/embed-tokens", { merchant: "r-1" });
    donJulio = minted.json().token;
  });

  it("ve solo su propio comercio", async () => {
    const res = await asEmbed(donJulio)("GET", "/embed/summary");

    expect(res.statusCode).toBe(200);
    expect(res.json().merchant.displayName).toBe("Don Julio");
  });

  it("ignora cualquier merchant que venga en la query", async () => {
    // Es el ataque directo: el comercio edita la URL del iframe agregando el
    // comercio del vecino. El endpoint tiene que usar SOLO el token.
    const res = await asEmbed(donJulio)("GET", "/embed/summary?merchant=la-vecina");

    expect(res.statusCode).toBe(200);
    expect(res.json().merchant.displayName).toBe("Don Julio");
  });

  it("no cuenta las tarjetas de otro comercio", async () => {
    // Dos clientes en Don Julio, uno en La Vecina.
    const elmenu = asProduct(elmenuToken);
    await elmenu("PUT", "/v1/programs", {
      merchant: "r-2",
      kind: "points",
      config: { earn: [{ on: "order.paid", points: 1 }] },
    });

    for (const phone of ["0993111111", "0993222222"]) {
      await elmenu("POST", "/v1/memberships", { merchant: "r-1", phone, phoneVerified: true });
    }
    await elmenu("POST", "/v1/memberships", {
      merchant: "r-2",
      phone: "0993333333",
      phoneVerified: true,
    });

    const res = await asEmbed(donJulio)("GET", "/embed/summary");
    expect(res.json().cards).toBe(2);
  });

  it("el link de alta es el de su comercio", async () => {
    const res = await asEmbed(donJulio)("GET", "/embed/enrollment-link");

    expect(res.json().slug).toBe("don-julio");
    expect(res.json().url).toContain("/don-julio");
  });

  it("devuelve la configuración de su programa", async () => {
    const res = await asEmbed(donJulio)("GET", "/embed/program");

    expect(res.statusCode).toBe(200);
    expect(res.json().kind).toBe("points");
    expect(res.json().config.earn[0].rate.per).toBe(10_000);
  });

  it("404 si el comercio todavía no configuró programa", async () => {
    const minted = await asProduct(elmenuToken)("POST", "/v1/embed-tokens", { merchant: "r-2" });
    const res = await asEmbed(minted.json().token)("GET", "/embed/program");

    expect(res.statusCode).toBe(404);
  });

  it("rechaza pedidos sin token", async () => {
    expect((await app.inject({ method: "GET", url: "/embed/summary" })).statusCode).toBe(401);
  });
});

describe("vencimiento", () => {
  it("rechaza un token vencido", async () => {
    const { token } = await issueEmbedToken(
      SIGNING_KEY,
      { merchantId: "00000000-0000-0000-0000-000000000000", productId: "p" },
      -1,
    );

    expect(await verifyEmbedToken(SIGNING_KEY, token)).toBeNull();
    expect((await asEmbed(token)("GET", "/embed/summary")).statusCode).toBe(401);
  });
});
