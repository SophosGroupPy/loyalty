/**
 * Web service de Apple Wallet.
 *
 * Lo que se prueba acá son los códigos de respuesta, y no es un detalle: Apple
 * distingue los casos por código, no por cuerpo. Devolver 200 donde va 201, o
 * 200 con lista vacía donde va 204, hace que el iPhone se comporte mal sin que
 * aparezca ningún error de nuestro lado — y el síntoma llega semanas después
 * como "a algunos clientes no se les actualiza la tarjeta".
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { passAuthToken, verifyPassAuth } from "./apple.js";
import { hashSecret } from "./auth.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");
const PASS_TYPE = "pass.com.sophosgroup.l.don-julio";

let db: Db;
let app: FastifyInstance;
let membershipId: string;
let otroSerial: string;

const SERIAL = "SN-DON-JULIO-1";

async function seed() {
  const [product] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid-elmenu', ${await hashSecret("sec")})
        RETURNING id`,
  );

  const merchants: Record<string, string> = {};
  for (const [slug, name] of [
    ["don-julio", "Don Julio"],
    ["la-vecina", "La Vecina"],
  ] as const) {
    const [m] = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
          VALUES (${product!.id}, ${slug}, ${slug}, ${name + " SA"}, ${name})
          RETURNING id`,
    );
    merchants[slug] = m!.id;
  }

  const [person] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO person (phone_e164, consent_version, phone_verified_at)
        VALUES ('+595993427654', 'programa/v1', now()) RETURNING id`,
  );

  const ids: string[] = [];
  for (const [slug, serial] of [
    ["don-julio", SERIAL],
    ["la-vecina", "SN-LA-VECINA-1"],
  ] as const) {
    const [program] = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO program (merchant_id, kind, config, status)
          VALUES (${merchants[slug]!}, 'points',
                  ${JSON.stringify({ earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] })}::jsonb,
                  'active')
          RETURNING id`,
    );
    const [membership] = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO membership (person_id, program_id, merchant_id, serial_number)
          VALUES (${person!.id}, ${program!.id}, ${merchants[slug]!}, ${serial})
          RETURNING id`,
    );
    await rows(
      db.drizzle,
      sql`INSERT INTO pass_instance (membership_id, merchant_id, platform, external_id)
          VALUES (${membership!.id}, ${merchants[slug]!}, 'apple', ${serial})`,
    );
    ids.push(membership!.id);
  }

  membershipId = ids[0]!;
  otroSerial = "SN-LA-VECINA-1";
}

beforeEach(async () => {
  db = await createTestDb();
  app = createServer({ db, signingKey: SIGNING_KEY });
  await app.ready();
  await seed();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

const auth = (serial = SERIAL) => `ApplePass ${passAuthToken(serial, SIGNING_KEY)}`;

const registrationUrl = (serial = SERIAL, device = "dev-1") =>
  `/apple/v1/devices/${device}/registrations/${PASS_TYPE}/${serial}`;

function register(serial = SERIAL, device = "dev-1", pushToken = "push-abc") {
  return app.inject({
    method: "POST",
    url: registrationUrl(serial, device),
    headers: { authorization: auth(serial) },
    payload: { pushToken },
  });
}

// ---------------------------------------------------------------------------

describe("credencial del pase", () => {
  it("es estable para el mismo serial y distinta para otro", () => {
    expect(passAuthToken(SERIAL, SIGNING_KEY)).toBe(passAuthToken(SERIAL, SIGNING_KEY));
    expect(passAuthToken(SERIAL, SIGNING_KEY)).not.toBe(passAuthToken("SN-OTRO", SIGNING_KEY));
  });

  it("cumple el mínimo de largo que exige Apple", () => {
    expect(passAuthToken(SERIAL, SIGNING_KEY).length).toBeGreaterThanOrEqual(16);
  });

  it("rechaza un header mal formado sin romperse", () => {
    for (const header of [undefined, "", "Bearer algo", "ApplePass", "ApplePass "]) {
      expect(verifyPassAuth(header, SERIAL, SIGNING_KEY)).toBe(false);
    }
  });

  it("la credencial de un pase no sirve para otro", () => {
    expect(verifyPassAuth(auth(otroSerial), SERIAL, SIGNING_KEY)).toBe(false);
  });
});

describe("registro del dispositivo", () => {
  it("201 la primera vez y 200 la segunda", async () => {
    // Apple usa esa diferencia para decidir si tiene que volver a pedir el pase.
    expect((await register()).statusCode).toBe(201);
    expect((await register()).statusCode).toBe(200);
  });

  it("actualiza el push token cuando el dispositivo re-registra", async () => {
    await register(SERIAL, "dev-1", "push-viejo");
    await register(SERIAL, "dev-1", "push-nuevo");

    const found = await rows<{ push_token: string }>(
      db.drizzle,
      sql`SELECT push_token FROM apple_device_registration WHERE device_library_identifier = 'dev-1'`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.push_token).toBe("push-nuevo");
  });

  it("401 con la credencial de otro pase", async () => {
    const res = await app.inject({
      method: "POST",
      url: registrationUrl(),
      headers: { authorization: auth(otroSerial) },
      payload: { pushToken: "push-abc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("401 sin credencial", async () => {
    const res = await app.inject({
      method: "POST",
      url: registrationUrl(),
      payload: { pushToken: "push-abc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 para un serial que no existe", async () => {
    const res = await app.inject({
      method: "POST",
      url: registrationUrl("SN-INVENTADO"),
      headers: { authorization: auth("SN-INVENTADO") },
      payload: { pushToken: "push-abc" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 si no manda push token", async () => {
    const res = await app.inject({
      method: "POST",
      url: registrationUrl(),
      headers: { authorization: auth() },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("baja del dispositivo", () => {
  it("borra el registro", async () => {
    await register();

    const res = await app.inject({
      method: "DELETE",
      url: registrationUrl(),
      headers: { authorization: auth() },
    });
    expect(res.statusCode).toBe(200);

    const quedan = await rows<{ id: string }>(
      db.drizzle,
      sql`SELECT id FROM apple_device_registration`,
    );
    expect(quedan).toHaveLength(0);
  });

  it("200 aunque no estuviera registrado", async () => {
    // El cliente borró la tarjeta: el resultado deseado ya se cumplió. Un 404
    // haría que el dispositivo reintente para siempre algo que no tiene arreglo.
    const res = await app.inject({
      method: "DELETE",
      url: registrationUrl(),
      headers: { authorization: auth() },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("pases con cambios", () => {
  it("204 cuando no hay ninguno registrado", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/apple/v1/devices/dev-1/registrations/${PASS_TYPE}`,
    });
    // Con 200 y lista vacía el dispositivo vuelve a pedir todos los pases.
    expect(res.statusCode).toBe(204);
  });

  it("lista el serial del pase registrado", async () => {
    await register();

    const res = await app.inject({
      method: "GET",
      url: `/apple/v1/devices/dev-1/registrations/${PASS_TYPE}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().serialNumbers).toEqual([SERIAL]);
    expect(res.json().lastUpdated).toBeTypeOf("string");
  });

  it("204 si no cambió nada desde la última consulta", async () => {
    await register();

    const primera = await app.inject({
      method: "GET",
      url: `/apple/v1/devices/dev-1/registrations/${PASS_TYPE}`,
    });
    const marca = primera.json().lastUpdated;

    const segunda = await app.inject({
      method: "GET",
      url: `/apple/v1/devices/dev-1/registrations/${PASS_TYPE}?passesUpdatedSince=${marca}`,
    });
    expect(segunda.statusCode).toBe(204);
  });

  it("no repite el pase cuando el timestamp trae microsegundos", async () => {
    // Es el bug que PGlite no puede mostrar: Postgres guarda microsegundos y la
    // marca que le devolvemos a Apple viene de `Date`, que solo tiene
    // milisegundos. Si la columna guardara `.123456`, sería siempre mayor que
    // la marca `.123` y el iPhone volvería a pedir el pase en cada despertar.
    // La columna es timestamptz(3) justamente para que eso no pueda pasar.
    await register();
    await rows(
      db.drizzle,
      sql`UPDATE pass_instance SET content_updated_at = '2026-09-01 12:00:00.123456+00'
          WHERE membership_id = ${membershipId}`,
    );

    const guardado = await rows<{ micros: string }>(
      db.drizzle,
      sql`SELECT date_part('microseconds', content_updated_at)::text AS micros
          FROM pass_instance WHERE membership_id = ${membershipId}`,
    );
    expect(Number(guardado[0]!.micros) % 1000).toBe(0);

    const marca = String(Date.UTC(2026, 8, 1, 12, 0, 0, 123));
    const res = await app.inject({
      method: "GET",
      url: `/apple/v1/devices/dev-1/registrations/${PASS_TYPE}?passesUpdatedSince=${marca}`,
    });
    expect(res.statusCode).toBe(204);
  });

  it("un dispositivo no ve los pases de otro", async () => {
    await register(SERIAL, "dev-1");
    await register(otroSerial, "dev-2");

    const res = await app.inject({
      method: "GET",
      url: `/apple/v1/devices/dev-1/registrations/${PASS_TYPE}`,
    });
    expect(res.json().serialNumbers).toEqual([SERIAL]);
  });
});

describe("entrega del pase", () => {
  it("dice que falta el material de firma en vez de devolver un archivo roto", async () => {
    // Sin el certificado del Pass Type ID no se puede emitir un .pkpass que iOS
    // acepte. Un archivo inválido lo rechazaría el teléfono sin decir por qué.
    const res = await app.inject({
      method: "GET",
      url: `/apple/v1/passes/${PASS_TYPE}/${SERIAL}`,
      headers: { authorization: auth() },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("apple_signing_not_configured");
  });

  it("exige credencial igual", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/apple/v1/passes/${PASS_TYPE}/${SERIAL}`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("log del dispositivo", () => {
  it("acepta lo que manda Apple", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/apple/v1/log",
      payload: { logs: ["no se pudo agregar el pase"] },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("aislamiento del token de producto", () => {
  it("las rutas de Apple no exigen token de producto", async () => {
    // Viven fuera de /v1/ a propósito: quien llama es un iPhone, no un backend.
    expect((await register()).statusCode).toBe(201);
  });

  it("membershipId queda ligado al comercio correcto", async () => {
    await register();
    const found = await rows<{ membership_id: string }>(
      db.drizzle,
      sql`SELECT membership_id FROM apple_device_registration`,
    );
    expect(found[0]?.membership_id).toBe(membershipId);
  });
});

describe("el pase se marca como cambiado al acumular", () => {
  /**
   * `syncPassInBackground` no se espera a propósito —el cliente ya consumió y
   * sus puntos le corresponden aunque la wallet esté caída— así que acá hay que
   * esperar a que termine en vez de asumirlo.
   */
  async function esperarMarca(desde: number, intentos = 40): Promise<number> {
    for (let i = 0; i < intentos; i++) {
      const [row] = await rows<{ t: Date }>(
        db.drizzle,
        sql`SELECT content_updated_at AS t FROM pass_instance
            WHERE membership_id = ${membershipId}`,
      );
      const t = new Date(row!.t).getTime();
      if (t > desde) return t;
      await new Promise((r) => setTimeout(r, 25));
    }
    return 0;
  }

  it("una acumulación deja el pase en la lista de cambios del dispositivo", async () => {
    await register();

    const [antes] = await rows<{ t: Date }>(
      db.drizzle,
      sql`SELECT content_updated_at AS t FROM pass_instance WHERE membership_id = ${membershipId}`,
    );
    const marcaPrevia = new Date(antes!.t).getTime();

    const token = (
      await app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: { grant_type: "client_credentials", client_id: "cid-elmenu", client_secret: "sec" },
      })
    ).json().access_token;

    const evento = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merchant: "don-julio",
        type: "order.paid",
        idempotencyKey: "pedido-1",
        membership: { serial: SERIAL },
        amount: 50_000,
      },
    });
    expect(evento.statusCode).toBe(201);

    const marcaNueva = await esperarMarca(marcaPrevia);
    expect(marcaNueva).toBeGreaterThan(marcaPrevia);

    // Y lo que importa de verdad: el dispositivo lo ve como pendiente.
    const res = await app.inject({
      method: "GET",
      url: `/apple/v1/devices/dev-1/registrations/${PASS_TYPE}?passesUpdatedSince=${marcaPrevia}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().serialNumbers).toEqual([SERIAL]);
  });
});
