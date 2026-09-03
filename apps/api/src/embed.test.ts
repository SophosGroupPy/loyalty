/**
 * Consola embebible: emisión del token y aislamiento.
 *
 * Lo que se prueba acá no es la UI sino la propiedad de la que depende todo el
 * modelo: **un comercio no puede alcanzar los datos de otro por más que edite
 * el request**. Si eso falla, el módulo no se puede vender.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  return (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload: payload as object } : {}),
    });
}

function asEmbed(token: string) {
  return (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
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

  it("cambia la regla de acumulación sin tocar el resto", async () => {
    const antes = (await asEmbed(donJulio)("GET", "/embed/program")).json();

    const res = await asEmbed(donJulio)("PUT", "/embed/program", {
      kind: "points",
      per: 5_000,
      points: 1,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().config.earn[0].rate.per).toBe(5_000);

    // Lo que administran otras pantallas —topes, vencimiento, huso— tiene que
    // sobrevivir: si esta pantalla mandara el objeto entero, pisaría lo que la
    // de ajustes acaba de guardar.
    const despues = (await asEmbed(donJulio)("GET", "/embed/program")).json();
    expect(despues.config.timezone).toBe(antes.config.timezone);
    expect(despues.config.caps).toEqual(antes.config.caps);
    expect(despues.config.expiry).toEqual(antes.config.expiry);
  });

  it("el cambio queda vivo: el próximo consumo acumula con la regla nueva", async () => {
    await asEmbed(donJulio)("PUT", "/embed/program", {
      kind: "points",
      per: 5_000,
      points: 1,
    });

    const card = await asProduct(elmenuToken)("POST", "/v1/memberships", {
      merchant: "r-1",
      phone: "0993999888",
      phoneVerified: true,
    });

    const evento = await asProduct(elmenuToken)("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "pedido-regla-nueva",
      type: "order.paid",
      amount: 50_000,
      membership: { id: card.json().membershipId },
    });

    // Con la regla vieja (1 cada 10.000) habrían sido 5.
    expect(evento.json().balance).toBe(10);
  });

  it("no deja pasar de puntos a sellos con tarjetas emitidas", async () => {
    await asProduct(elmenuToken)("POST", "/v1/memberships", {
      merchant: "r-1",
      phone: "0993777666",
      phoneVerified: true,
    });

    // Con saldos vivos el cambio reinterpreta lo acumulado: 340 puntos pasarían
    // a ser 340 sellos, que es otra cosa y mucho más valiosa.
    const res = await asEmbed(donJulio)("PUT", "/embed/program", {
      kind: "stamps",
      rewardAt: 10,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("kind_change_blocked");
  });

  it("no borra los multiplicadores ni las reglas de otros eventos", async () => {
    // Un happy hour y una regla de otro evento, como las que configura otra
    // pantalla. `earn` es la lista completa, no una sola regla.
    await asProduct(elmenuToken)("PUT", "/v1/programs", {
      merchant: "r-1",
      kind: "points",
      config: {
        earn: [
          { on: "order.paid", rate: { per: 10_000, points: 1 } },
          { on: "order.paid", multiplier: 2, when: { weekday: ["thu"] } },
          { on: "ticket.validated", points: 5 },
        ],
      },
    });

    const nuevo = await asProduct(elmenuToken)("POST", "/v1/embed-tokens", { merchant: "r-1" });
    await asEmbed(nuevo.json().token)("PUT", "/embed/program", {
      kind: "points",
      per: 5_000,
      points: 1,
    });

    const despues = (await asEmbed(nuevo.json().token)("GET", "/embed/program")).json();
    const reglas = despues.config.earn;

    // La base cambió…
    expect(reglas.find((r: { rate?: { per: number } }) => r.rate)?.rate.per).toBe(5_000);
    // …y lo demás sigue vivo.
    expect(reglas.some((r: { multiplier?: number }) => r.multiplier === 2)).toBe(true);
    expect(reglas.some((r: { on: string }) => r.on === "ticket.validated")).toBe(true);
  });

  it("cambiar el diseño avisa a los pases ya emitidos", async () => {
    // Sin esto el comercio cambia su logo, la pantalla le dice que se
    // actualiza solo, y las tarjetas de sus clientes siguen mostrando el logo
    // viejo para siempre: PassKit solo baja una versión nueva si
    // `content_updated_at` avanzó.
    const card = await asProduct(elmenuToken)("POST", "/v1/memberships", {
      merchant: "r-1",
      phone: "0993555444",
      phoneVerified: true,
    });
    const membershipId = card.json().membershipId;

    await rows(
      db.drizzle,
      sql`INSERT INTO pass_instance (membership_id, merchant_id, platform, external_id,
                                     state, last_synced_balance, content_updated_at)
          SELECT id, merchant_id, 'apple', 'p-diseno', 'active', 0,
                 now() - interval '2 days'
            FROM membership WHERE id = ${membershipId}`,
    );

    const antes = await rows<{ content_updated_at: Date }>(
      db.drizzle,
      sql`SELECT content_updated_at FROM pass_instance WHERE external_id = 'p-diseno'`,
    );

    const res = await asEmbed(donJulio)("PUT", "/embed/design", {
      programName: "Puntos Don Julio",
      logoUrl: "https://ejemplo.test/logo.png",
      backgroundColor: "#FFE066",
      foregroundColor: "#111111",
      labelColor: "#666666",
      balanceLabel: "Puntos",
      newsLabel: "Novedades",
    });
    expect(res.statusCode, res.body).toBe(200);

    const despues = await rows<{ content_updated_at: Date }>(
      db.drizzle,
      sql`SELECT content_updated_at FROM pass_instance WHERE external_id = 'p-diseno'`,
    );

    expect(
      new Date(despues[0]!.content_updated_at).getTime(),
    ).toBeGreaterThan(new Date(antes[0]!.content_updated_at).getTime());
  });

  it("la baja corta la acumulación y conserva el historial", async () => {
    const card = await asProduct(elmenuToken)("POST", "/v1/memberships", {
      merchant: "r-1",
      phone: "0993111222",
      phoneVerified: true,
      displayName: "Ana",
    });
    const id = card.json().membershipId;

    await asProduct(elmenuToken)("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "antes-de-la-baja",
      type: "order.paid",
      amount: 50_000,
      membership: { id },
    });

    const baja = await asEmbed(donJulio)("POST", `/embed/customers/${id}`, { modo: "baja" });
    expect(baja.statusCode, baja.body).toBe(200);

    // Ya no acumula. El evento igual se registra —es lo que pasó— pero no
    // acredita: se responde con el motivo en vez de tragárselo en silencio.
    const despues = await asProduct(elmenuToken)("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "despues-de-la-baja",
      type: "order.paid",
      amount: 50_000,
      membership: { id },
    });
    expect(despues.json().skipped).toBe("no_membership");

    // …pero el saldo y el asiento siguen ahí: es la deuda del comercio con esa
    // persona y el registro de lo que pasó, no datos de identidad.
    const fila = await rows<{ balance: number; display_name: string | null }>(
      db.drizzle,
      sql`SELECT balance, display_name FROM membership WHERE id = ${id}`,
    );
    expect(fila[0]?.balance).toBe(5);
    expect(fila[0]?.display_name).toBe("Ana");
  });

  it("borrar vacía los datos personales pero no el saldo", async () => {
    const card = await asProduct(elmenuToken)("POST", "/v1/memberships", {
      merchant: "r-1",
      phone: "0993111333",
      phoneVerified: true,
      displayName: "Ana",
      email: "ana@ejemplo.com",
      birthdate: "1990-04-17",
    });
    const id = card.json().membershipId;

    await asProduct(elmenuToken)("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "antes-del-borrado",
      type: "order.paid",
      amount: 50_000,
      membership: { id },
    });

    const res = await asEmbed(donJulio)("POST", `/embed/customers/${id}`, { modo: "borrar" });
    expect(res.statusCode, res.body).toBe(200);

    const fila = await rows<{
      status: string;
      display_name: string | null;
      email: string | null;
      birthdate: string | null;
      balance: number;
    }>(
      db.drizzle,
      sql`SELECT status, display_name, email, birthdate, balance
            FROM membership WHERE id = ${id}`,
    );

    // Los campos se vacían de verdad: guardarlos "por las dudas" es lo que la
    // persona pidió que no pase.
    expect(fila[0]?.status).toBe("deleted");
    expect(fila[0]?.display_name).toBeNull();
    expect(fila[0]?.email).toBeNull();
    expect(fila[0]?.birthdate).toBeNull();
    // El saldo queda: es una deuda del comercio, no un dato personal.
    expect(fila[0]?.balance).toBe(5);
  });

  it("si vuelve, se reactiva con su saldo y se le manda la tarjeta de nuevo", async () => {
    const card = await asProduct(elmenuToken)("POST", "/v1/memberships", {
      merchant: "r-1",
      phone: "0993111444",
      phoneVerified: true,
    });
    const id = card.json().membershipId;

    await asProduct(elmenuToken)("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "antes-de-volver",
      type: "order.paid",
      amount: 90_000,
      membership: { id },
    });

    await asEmbed(donJulio)("POST", `/embed/customers/${id}`, { modo: "baja" });

    const vuelve = await asProduct(elmenuToken)("POST", "/v1/memberships", {
      merchant: "r-1",
      phone: "0993111444",
      phoneVerified: true,
      displayName: "Ana otra vez",
    });

    // `created: true` a propósito: para la persona esto ES un alta, y el
    // producto tiene que volver a entregarle su tarjeta. Con `false` el
    // reingreso sería mudo.
    expect(vuelve.json().created).toBe(true);
    expect(vuelve.json().membershipId).toBe(id);
    expect(vuelve.json().balance).toBe(9);

    // Y vuelve a acumular.
    const evento = await asProduct(elmenuToken)("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "ya-volvio",
      type: "order.paid",
      amount: 10_000,
      membership: { id },
    });
    expect(evento.statusCode).toBe(201);
    expect(evento.json().balance).toBe(10);
  });

  it("un comercio no puede dar de baja al cliente de otro", async () => {
    const card = await asProduct(elmenuToken)("POST", "/v1/memberships", {
      merchant: "r-1",
      phone: "0993111555",
      phoneVerified: true,
    });

    const otro = await asProduct(elmenuToken)("POST", "/v1/embed-tokens", { merchant: "r-2" });
    const res = await asEmbed(otro.json().token)(
      "POST",
      `/embed/customers/${card.json().membershipId}`,
      { modo: "borrar" },
    );
    expect(res.statusCode).toBe(404);
  });

  it("un comercio no puede editar el programa de otro", async () => {
    const otro = await asProduct(elmenuToken)("POST", "/v1/embed-tokens", { merchant: "r-2" });
    const res = await asEmbed(otro.json().token)("PUT", "/embed/program", {
      kind: "points",
      per: 1_000,
      points: 99,
    });

    // Su propio token solo alcanza a su comercio, que no tiene programa.
    expect(res.statusCode).toBe(404);

    const donJulioSigue = (await asEmbed(donJulio)("GET", "/embed/program")).json();
    expect(donJulioSigue.config.earn[0].rate.points).toBe(1);
  });
});

describe("campañas desde la consola", () => {
  let donJulio: string;
  let laVecina: string;

  beforeEach(async () => {
    const elmenu = asProduct(elmenuToken);
    await elmenu("PUT", "/v1/programs", {
      merchant: "r-2",
      kind: "points",
      config: { earn: [{ on: "order.paid", points: 1 }] },
    });

    for (const [merchant, phone] of [
      ["r-1", "0993111111"],
      ["r-2", "0993222222"],
    ] as const) {
      await elmenu("POST", "/v1/memberships", { merchant, phone, phoneVerified: true });
    }

    donJulio = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-1" })).json().token;
    laVecina = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-2" })).json().token;
  });

  it("crea la campaña y la encola para su propia base", async () => {
    const res = await asEmbed(donJulio)("POST", "/embed/campaigns", {
      header: "2x1 en pizzas",
      body: "Hoy hasta las 23",
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().targeted).toBe(1);
  });

  it("un comercio no ve las campañas de otro", async () => {
    await asEmbed(donJulio)("POST", "/embed/campaigns", {
      header: "Solo de Don Julio",
      body: "x",
    });

    const ajeno = await asEmbed(laVecina)("GET", "/embed/campaigns");
    expect(ajeno.json().campaigns).toEqual([]);

    const propio = await asEmbed(donJulio)("GET", "/embed/campaigns");
    expect(propio.json().campaigns).toHaveLength(1);
    expect(propio.json().campaigns[0].header).toBe("Solo de Don Julio");
  });

  it("el alcance cuenta solo los clientes propios", async () => {
    const res = await asEmbed(donJulio)("GET", "/embed/campaigns/reach");
    expect(res.json().total).toBe(1);
  });

  it("no cuenta como alcanzable a quien no tiene el pase instalado", async () => {
    // El canal ES la tarjeta en la billetera: sin pase no hay dónde entregar
    // nada. Contarlo infla el número y le promete al comercio un alcance que el
    // sistema no puede cumplir, que es justo lo que este medidor evita.
    const sinPase = await asEmbed(donJulio)("GET", "/embed/campaigns/reach");
    expect(sinPase.json().total).toBe(1);
    expect(sinPase.json().reachable).toBe(0);

    await rows(
      db.drizzle,
      sql`INSERT INTO pass_instance (membership_id, merchant_id, platform, external_id,
                                     state, last_synced_balance)
          SELECT m.id, m.merchant_id, 'google', 'obj-alcance', 'active', 0
            FROM membership m
            JOIN merchant mer ON mer.id = m.merchant_id
           WHERE mer.slug = 'don-julio'
           LIMIT 1`,
    );

    const conPase = await asEmbed(donJulio)("GET", "/embed/campaigns/reach");
    expect(conPase.json().reachable).toBe(1);
  });

  it("apagar un aviso automático no afecta a otro comercio", async () => {
    await asEmbed(donJulio)("PUT", "/embed/notifications", {
      disabledKinds: ["tier_changed"],
    });

    const propio = await asEmbed(donJulio)("GET", "/embed/notifications");
    const tier = propio.json().kinds.find((k: { id: string }) => k.id === "tier_changed");
    expect(tier.enabled).toBe(false);

    // El vecino queda como estaba: la configuración vive en SU programa.
    const vecino = await asEmbed(laVecina)("GET", "/embed/notifications");
    const suTier = vecino.json().kinds.find((k: { id: string }) => k.id === "tier_changed");
    expect(suTier.enabled).toBe(true);
  });

  it("no expone los límites de plataforma como tales, pero sí el cupo", async () => {
    const res = await asEmbed(donJulio)("GET", "/embed/notifications");

    // La consola necesita el número para traducirlo a "a cuántos les llega";
    // lo que no hace es mostrárselo al comercio como "3 pushes por pase".
    expect(res.json().dailyBudget).toBe(3);
    expect(res.json().campaignBudget).toBe(2);
  });
});

describe("beneficios desde la consola", () => {
  let donJulio: string;
  let laVecina: string;

  beforeEach(async () => {
    const elmenu = asProduct(elmenuToken);
    await elmenu("PUT", "/v1/programs", {
      merchant: "r-2",
      kind: "points",
      config: { earn: [{ on: "order.paid", points: 1 }] },
    });

    donJulio = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-1" })).json().token;
    laVecina = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-2" })).json().token;
  });

  it("crea un beneficio y lo lista", async () => {
    const creado = await asEmbed(donJulio)("POST", "/embed/rewards", {
      name: "Café gratis",
      cost: 10,
      terms: "No acumulable",
    });
    expect(creado.statusCode, creado.body).toBe(201);

    const lista = await asEmbed(donJulio)("GET", "/embed/rewards");
    expect(lista.json().rewards).toHaveLength(1);
    expect(lista.json().rewards[0].name).toBe("Café gratis");
  });

  it("cuenta cuántos clientes ya pueden canjearlo", async () => {
    const elmenu = asProduct(elmenuToken);
    await asEmbed(donJulio)("POST", "/embed/rewards", { name: "Café gratis", cost: 10 });

    // Dos clientes: uno llega al umbral, el otro no.
    for (const [phone, amount] of [
      ["0993111111", 150_000],
      ["0993222222", 30_000],
    ] as const) {
      const card = await elmenu("POST", "/v1/memberships", {
        merchant: "r-1",
        phone,
        phoneVerified: true,
      });
      await elmenu("POST", "/v1/events", {
        merchant: "r-1",
        idempotencyKey: `ev-${phone}`,
        type: "order.paid",
        amount,
        membership: { id: card.json().membershipId },
      });
    }

    const lista = await asEmbed(donJulio)("GET", "/embed/rewards");
    expect(lista.json().members).toBe(2);
    // Es el número que le dice al comercio si su umbral tiene sentido.
    expect(lista.json().rewards[0].can_afford).toBe(1);
  });

  it("archiva sin borrar, para no romper el historial de canjes", async () => {
    const creado = await asEmbed(donJulio)("POST", "/embed/rewards", {
      name: "Café gratis",
      cost: 10,
    });
    const id = creado.json().id;

    await asEmbed(donJulio)("PUT", `/embed/rewards/${id}`, { status: "archived" });

    const lista = await asEmbed(donJulio)("GET", "/embed/rewards");
    // Sigue existiendo, solo cambió de estado.
    expect(lista.json().rewards).toHaveLength(1);
    expect(lista.json().rewards[0].status).toBe("archived");
  });

  it("un comercio no ve ni archiva los beneficios de otro", async () => {
    const creado = await asEmbed(donJulio)("POST", "/embed/rewards", {
      name: "Solo de Don Julio",
      cost: 10,
    });

    expect((await asEmbed(laVecina)("GET", "/embed/rewards")).json().rewards).toEqual([]);

    const ajeno = await asEmbed(laVecina)("PUT", `/embed/rewards/${creado.json().id}`, {
      status: "archived",
    });
    expect(ajeno.statusCode).toBe(404);
  });

  it("rechaza un costo en cero o negativo", async () => {
    for (const cost of [0, -5]) {
      const res = await asEmbed(donJulio)("POST", "/embed/rewards", { name: "X", cost });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("diseño de la tarjeta", () => {
  let donJulio: string;
  let laVecina: string;

  const valido = {
    programName: "Puntos Don Julio",
    logoUrl: "https://cdn.test/logo.png",
    backgroundColor: "#DC2626",
    balanceLabel: "Puntos",
    newsLabel: "Novedades",
    foregroundColor: "#FFFFFF",
    labelColor: "#FFFFFF",
  };

  beforeEach(async () => {
    const elmenu = asProduct(elmenuToken);
    await elmenu("PUT", "/v1/programs", {
      merchant: "r-2",
      kind: "stamps",
      config: { earn: [{ on: "order.paid", stamps: 1 }], rewardAt: 10 },
    });
    donJulio = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-1" })).json().token;
    laVecina = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-2" })).json().token;
  });

  it("devuelve valores por defecto usables antes de configurar nada", async () => {
    const res = await asEmbed(donJulio)("GET", "/embed/design");

    expect(res.statusCode).toBe(200);
    // La pantalla necesita algo que dibujar desde el primer momento.
    expect(res.json().design.programName).toBe("Don Julio");
    expect(res.json().design.backgroundColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(res.json().design.newsLabel).toBe("Novedades");
  });

  it("adapta la etiqueta del saldo al tipo de programa", async () => {
    expect((await asEmbed(donJulio)("GET", "/embed/design")).json().design.balanceLabel).toBe(
      "Puntos",
    );
    expect((await asEmbed(laVecina)("GET", "/embed/design")).json().design.balanceLabel).toBe(
      "Sellos",
    );
  });

  it("guarda y devuelve lo guardado", async () => {
    const guardado = await asEmbed(donJulio)("PUT", "/embed/design", {
      ...valido,
      backgroundColor: "#FFE066",
      foregroundColor: "#3D2B00",
    });
    expect(guardado.statusCode, guardado.body).toBe(200);

    const leido = await asEmbed(donJulio)("GET", "/embed/design");
    expect(leido.json().design.backgroundColor).toBe("#FFE066");
    expect(leido.json().design.foregroundColor).toBe("#3D2B00");
  });

  it("no deja vaciar el campo de novedades", async () => {
    // En Apple es el único vehículo de notificación; sin él la tarjeta queda
    // muda y agregarlo después obliga a reemitir todos los pases.
    const res = await asEmbed(donJulio)("PUT", "/embed/design", { ...valido, newsLabel: "" });
    expect(res.statusCode).toBe(400);
  });

  it("rechaza colores que no sean hex de seis dígitos", async () => {
    for (const color of ["rojo", "#FFF", "rgb(0,0,0)", ""]) {
      const res = await asEmbed(donJulio)("PUT", "/embed/design", {
        ...valido,
        backgroundColor: color,
      });
      expect(res.statusCode, `aceptó ${color}`).toBe(400);
    }
  });

  it("el diseño de un comercio no toca el de otro", async () => {
    await asEmbed(donJulio)("PUT", "/embed/design", { ...valido, backgroundColor: "#111111" });

    const vecino = await asEmbed(laVecina)("GET", "/embed/design");
    expect(vecino.json().design.backgroundColor).not.toBe("#111111");
    expect(vecino.json().merchantName).toBe("La Vecina");
  });
});

describe("base de clientes", () => {
  let donJulio: string;
  let laVecina: string;

  beforeEach(async () => {
    const elmenu = asProduct(elmenuToken);
    await elmenu("PUT", "/v1/programs", {
      merchant: "r-2",
      kind: "points",
      config: { earn: [{ on: "order.paid", points: 1 }] },
    });

    // Ana: muchas visitas de ticket bajo. Bruno: pocas de ticket alto.
    for (const [phone, nombre, visitas, ticket] of [
      ["0993111111", "Ana Vera", 4, 50_000],
      ["0993222222", "Bruno Diaz", 2, 300_000],
    ] as const) {
      const card = await elmenu("POST", "/v1/memberships", {
        merchant: "r-1",
        phone,
        displayName: nombre,
        phoneVerified: true,
      });
      for (let v = 1; v <= visitas; v++) {
        await elmenu("POST", "/v1/events", {
          merchant: "r-1",
          idempotencyKey: `${phone}-${v}`,
          type: "order.paid",
          amount: ticket,
          membership: { id: card.json().membershipId },
        });
      }
    }

    donJulio = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-1" })).json().token;
    laVecina = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-2" })).json().token;
  });

  it("deriva visitas, gasto y ticket promedio de los eventos ya recibidos", async () => {
    const res = await asEmbed(donJulio)("GET", "/embed/customers?sort=spend");
    const [bruno, ana] = res.json().customers;

    // Sin importar ningún CRM: sale de los `order.paid` que el producto manda.
    expect(bruno.display_name).toBe("Bruno Diaz");
    expect(bruno.visits).toBe(2);
    expect(bruno.total_spent).toBe(600_000);
    expect(bruno.avg_ticket).toBe(300_000);

    expect(ana.visits).toBe(4);
    expect(ana.avg_ticket).toBe(50_000);
  });

  it("ordena por gasto y por visitas de forma distinta", async () => {
    // El que más gastó no es el que más vino: es justamente la distinción que
    // el comercio necesita para decidir a quién cuidar.
    const porGasto = await asEmbed(donJulio)("GET", "/embed/customers?sort=spend");
    expect(porGasto.json().customers[0].display_name).toBe("Bruno Diaz");

    const porVisitas = await asEmbed(donJulio)("GET", "/embed/customers?sort=visits");
    expect(porVisitas.json().customers[0].display_name).toBe("Ana Vera");
  });

  it("busca por nombre y por celular", async () => {
    const porNombre = await asEmbed(donJulio)("GET", "/embed/customers?q=Ana");
    expect(porNombre.json().customers).toHaveLength(1);

    const porTelefono = await asEmbed(donJulio)("GET", "/embed/customers?q=222222");
    expect(porTelefono.json().customers[0].display_name).toBe("Bruno Diaz");
  });

  it("un comercio no ve la base de otro", async () => {
    expect((await asEmbed(laVecina)("GET", "/embed/customers")).json().customers).toEqual([]);
  });

  it("no deja leer el historial de una tarjeta de otro comercio", async () => {
    const mios = await asEmbed(donJulio)("GET", "/embed/customers");
    const id = mios.json().customers[0].id;

    // Conocer el id de una tarjeta ajena no puede alcanzar para leer su
    // historial de consumo.
    const ajeno = await asEmbed(laVecina)("GET", `/embed/customers/${id}/history`);
    expect(ajeno.json().entries).toEqual([]);

    const propio = await asEmbed(donJulio)("GET", `/embed/customers/${id}/history`);
    expect(propio.json().entries.length).toBeGreaterThan(0);
  });
});

describe("ubicaciones", () => {
  let donJulio: string;
  let laVecina: string;

  beforeEach(async () => {
    const elmenu = asProduct(elmenuToken);
    donJulio = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-1" })).json().token;
    laVecina = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-2" })).json().token;
  });

  it("agrega y lista con el tope visible", async () => {
    const creada = await asEmbed(donJulio)("POST", "/embed/locations", {
      label: "Villa Morra",
      latitude: -25.2965,
      longitude: -57.5759,
      relevantText: "Estás cerca de Don Julio",
    });
    expect(creada.statusCode, creada.body).toBe(201);

    const lista = await asEmbed(donJulio)("GET", "/embed/locations");
    expect(lista.json().locations).toHaveLength(1);
    // El tope se expone para poder mostrarlo antes de que falle el alta 11.
    expect(lista.json().max).toBe(10);
  });

  it("corta en diez, que es el tope de Apple por pase", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await asEmbed(donJulio)("POST", "/embed/locations", {
        label: `Sucursal ${i}`,
        latitude: -25 - i / 100,
        longitude: -57,
      });
      expect(res.statusCode).toBe(201);
    }

    // Aceptar la 11 sería aceptar en falso: no dispararía nada y nadie se
    // enteraría.
    const extra = await asEmbed(donJulio)("POST", "/embed/locations", {
      label: "Sucursal 11",
      latitude: -25.5,
      longitude: -57,
    });
    expect(extra.statusCode).toBe(409);
    expect(extra.json().error).toBe("too_many_locations");
  });

  it("quitar una libera lugar para otra", async () => {
    const creada = await asEmbed(donJulio)("POST", "/embed/locations", {
      label: "Villa Morra",
      latitude: -25.2965,
      longitude: -57.5759,
    });

    await asEmbed(donJulio)("DELETE", `/embed/locations/${creada.json().id}`);
    expect((await asEmbed(donJulio)("GET", "/embed/locations")).json().locations).toEqual([]);
  });

  it("rechaza coordenadas fuera de rango", async () => {
    for (const [lat, lng] of [
      [95, -57],
      [-25, 200],
    ] as const) {
      const res = await asEmbed(donJulio)("POST", "/embed/locations", {
        label: "X",
        latitude: lat,
        longitude: lng,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("un comercio no ve ni borra las ubicaciones de otro", async () => {
    const creada = await asEmbed(donJulio)("POST", "/embed/locations", {
      label: "Villa Morra",
      latitude: -25.2965,
      longitude: -57.5759,
    });

    expect((await asEmbed(laVecina)("GET", "/embed/locations")).json().locations).toEqual([]);

    const ajeno = await asEmbed(laVecina)("DELETE", `/embed/locations/${creada.json().id}`);
    expect(ajeno.statusCode).toBe(404);
  });
});

describe("ajustes del programa", () => {
  let donJulio: string;
  let laVecina: string;

  const base = {
    dayBoundaryHour: 0,
    quietHours: null,
    capPerDay: null,
    capPerEvent: null,
    expiryMonths: null,
  };

  beforeEach(async () => {
    const elmenu = asProduct(elmenuToken);
    await elmenu("PUT", "/v1/programs", {
      merchant: "r-2",
      kind: "points",
      config: { earn: [{ on: "order.paid", points: 1 }] },
    });
    donJulio = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-1" })).json().token;
    laVecina = (await elmenu("POST", "/v1/embed-tokens", { merchant: "r-2" })).json().token;
  });

  it("no borra las reglas de acumulación al guardar", async () => {
    // Es el riesgo real de esta pantalla: si el guardado reemplazara la config
    // entera en vez de mezclar, el programa dejaría de acumular en silencio y
    // nadie se enteraría hasta que un cliente reclamara.
    const antes = await asEmbed(donJulio)("GET", "/embed/program");
    expect(antes.json().config.earn).toHaveLength(1);

    await asEmbed(donJulio)("PUT", "/embed/settings", { ...base, capPerDay: 200 });

    const despues = await asEmbed(donJulio)("GET", "/embed/program");
    expect(despues.json().config.earn).toHaveLength(1);
    expect(despues.json().config.earn[0].rate.per).toBe(10_000);
    expect(despues.json().config.caps.perDay).toBe(200);
  });

  it("guarda la franja de silencio y permite quitarla", async () => {
    await asEmbed(donJulio)("PUT", "/embed/settings", {
      ...base,
      quietHours: { from: 6, to: 18 },
    });
    expect((await asEmbed(donJulio)("GET", "/embed/settings")).json().quietHours).toEqual({
      from: 6,
      to: 18,
    });

    await asEmbed(donJulio)("PUT", "/embed/settings", { ...base, quietHours: null });
    expect((await asEmbed(donJulio)("GET", "/embed/settings")).json().quietHours).toBeNull();
  });

  it("acepta el corte de día que necesita un local nocturno", async () => {
    // Con corte a las 6, la 1 AM del sábado se imputa al viernes: sin esto una
    // salida nocturna se parte en dos días y el tope diario se duplica.
    await asEmbed(donJulio)("PUT", "/embed/settings", { ...base, dayBoundaryHour: 6 });
    expect((await asEmbed(donJulio)("GET", "/embed/settings")).json().dayBoundaryHour).toBe(6);
  });

  it("rechaza valores imposibles", async () => {
    for (const patch of [
      { dayBoundaryHour: 24 },
      { quietHours: { from: 25, to: 9 } },
      { capPerDay: 0 },
      { expiryMonths: -3 },
    ]) {
      const res = await asEmbed(donJulio)("PUT", "/embed/settings", { ...base, ...patch });
      expect(res.statusCode, JSON.stringify(patch)).toBe(400);
    }
  });

  it("los ajustes de un comercio no tocan los de otro", async () => {
    await asEmbed(donJulio)("PUT", "/embed/settings", { ...base, capPerDay: 200 });

    const vecino = await asEmbed(laVecina)("GET", "/embed/settings");
    expect(vecino.json().caps.perDay).toBeNull();
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

// ---------------------------------------------------------------------------

describe("guardar el diseño llega a las tarjetas ya emitidas", () => {
  const disenoValido = {
    programName: "Don Julio",
    logoUrl: "",
    backgroundColor: "#111111",
    foregroundColor: "#FFFFFF",
    labelColor: "#CCCCCC",
    balanceLabel: "Puntos",
    newsLabel: "Novedades",
  };

  /** Un servidor con el servicio de pases espiado, sobre el mismo comercio. */
  async function conEspia() {
    const refreshGoogleClass = vi.fn().mockResolvedValue({ status: "updated" });
    const spy = {
      enabled: true,
      issueGooglePass: vi.fn(),
      syncGooglePass: vi.fn(),
      refreshGoogleClass,
      sendMessage: vi.fn(),
      pendingSync: vi.fn().mockResolvedValue([]),
    };
    const server = createServer({ db, signingKey: SIGNING_KEY, passService: spy });
    await server.ready();

    const prod = await server.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "client_credentials", client_id: "cid-elmenu", client_secret: "sec" },
    });
    const emb = await server.inject({
      method: "POST",
      url: "/v1/embed-tokens",
      headers: { authorization: `Bearer ${prod.json().access_token}` },
      payload: { merchant: "r-1" },
    });
    return { server, refreshGoogleClass, embedToken: emb.json().token as string };
  }

  it("re-registra la clase de Google del comercio, no una tarjeta suelta", async () => {
    // El bug: guardar el diseño marcaba las tarjetas como cambiadas y ahí
    // moría. La clase de Google es una por comercio, así que re-registrarla
    // actualiza todas las tarjetas de una.
    const { server, refreshGoogleClass, embedToken } = await conEspia();

    const res = await server.inject({
      method: "PUT",
      url: "/embed/design",
      headers: { authorization: `Bearer ${embedToken}` },
      payload: disenoValido,
    });
    expect(res.statusCode, res.body).toBe(200);

    const [donJulio] = await rows<{ id: string }>(
      db.drizzle,
      sql`SELECT id FROM merchant WHERE slug = 'don-julio'`,
    );
    expect(refreshGoogleClass).toHaveBeenCalledWith(donJulio!.id);

    await server.close();
  });

  it("un comercio no puede disparar el refresco de otro", async () => {
    // El refresco sale del comercio del token, nunca de un id del body.
    const { server, refreshGoogleClass, embedToken } = await conEspia();
    await server.inject({
      method: "PUT",
      url: "/embed/design",
      headers: { authorization: `Bearer ${embedToken}` },
      payload: disenoValido,
    });

    const [donJulio] = await rows<{ id: string }>(
      db.drizzle,
      sql`SELECT id FROM merchant WHERE slug = 'don-julio'`,
    );
    expect(refreshGoogleClass).toHaveBeenCalledWith(donJulio!.id);
    expect(refreshGoogleClass).toHaveBeenCalledTimes(1);

    await server.close();
  });
});
