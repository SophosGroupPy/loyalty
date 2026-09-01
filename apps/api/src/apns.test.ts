/**
 * Aviso a los dispositivos Apple.
 *
 * **El transporte no se prueba acá y no se probó en ningún lado.** Mandar de
 * verdad a `api.push.apple.com` necesita un push token real, que solo existe
 * cuando un iPhone logra registrarse contra el web service — o sea, después del
 * deploy. Lo que sí se prueba es todo lo que rodea al envío, que es donde están
 * las decisiones: a quién se le avisa, qué se hace con un token muerto, y qué
 * pasa cuando Apple rechaza.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import forge from "node-forge";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { passAuthToken } from "./apple.js";
import type { ApnsClient, PushResult } from "./apns.js";
import { hashSecret } from "./auth.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");
const ENCRYPTION_KEY = randomBytes(32).toString("hex");
const PASS_TYPE = "pass.com.sophosgroup.l.don-julio";
const SERIAL = "SN-DON-JULIO-1";

let db: Db;
let app: FastifyInstance;
let merchantId: string;
let membershipId: string;
let signer: { certificatePem: string; privateKeyPem: string };
let wwdrPem: string;

/** Cliente falso: registra a quién se le mandó y responde lo que le digamos. */
function stubApns(responder: (token: string) => PushResult = () => ({ status: "sent" })) {
  const enviados: { passType: string; token: string }[] = [];
  const client: ApnsClient = {
    push: vi.fn(async (passType: string, token: string) => {
      enviados.push({ passType, token });
      return responder(token);
    }),
    close: vi.fn(async () => {}),
  };
  return { client, enviados };
}

function makeCert(commonName: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(2020, 0, 1);
  cert.validity.notAfter = new Date(2030, 0, 1);
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { certificatePem: forge.pki.certificateToPem(cert), privateKeyPem: privateKey };
}

beforeAll(() => {
  signer = makeCert(`Pass Type ID: ${PASS_TYPE}`);
  wwdrPem = makeCert("Apple WWDR CA").certificatePem;
});

async function levantar(apns: ApnsClient) {
  app = createServer({
    db,
    signingKey: SIGNING_KEY,
    adminKey: "admin-de-test",
    appleWallet: {
      teamIdentifier: "3W23SYPG6H",
      webServiceURL: "https://tarjeta.sophosgroup.com.py",
      encryptionKey: ENCRYPTION_KEY,
      wwdrCertificatePem: wwdrPem,
      apns,
    },
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
  const [program] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO program (merchant_id, kind, config, status)
        VALUES (${merchantId}, 'points',
                ${JSON.stringify({ earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] })}::jsonb,
                'active')
        RETURNING id`,
  );
  const [membership] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO membership (person_id, program_id, merchant_id, serial_number, balance)
        VALUES (${person!.id}, ${program!.id}, ${merchantId}, ${SERIAL}, 100) RETURNING id`,
  );
  membershipId = membership!.id;

  await rows(
    db.drizzle,
    sql`INSERT INTO pass_instance (membership_id, merchant_id, platform, external_id)
        VALUES (${membershipId}, ${merchantId}, 'apple', ${SERIAL})`,
  );
});

afterEach(async () => {
  await app?.close();
  await db.close();
});

async function adminToken(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/session",
    payload: { key: "admin-de-test", operator: "test" },
  });
  return res.json().token;
}

async function cargarCertificado() {
  await app.inject({
    method: "PUT",
    url: `/admin/merchants/${merchantId}/pass-certificate`,
    headers: { authorization: `Bearer ${await adminToken()}` },
    payload: {
      passTypeIdentifier: PASS_TYPE,
      certificatePem: signer.certificatePem,
      privateKeyPem: signer.privateKeyPem,
    },
  });
}

function registrar(device: string, token: string) {
  return app.inject({
    method: "POST",
    url: `/apple/v1/devices/${device}/registrations/${PASS_TYPE}/${SERIAL}`,
    headers: { authorization: `ApplePass ${passAuthToken(SERIAL, SIGNING_KEY)}` },
    payload: { pushToken: token },
  });
}

const empujar = async () =>
  app.inject({
    method: "POST",
    url: `/admin/apple/push/${membershipId}`,
    headers: { authorization: `Bearer ${await adminToken()}` },
  });

const registros = () =>
  rows<{ push_token: string }>(db.drizzle, sql`SELECT push_token FROM apple_device_registration`);

// ---------------------------------------------------------------------------

describe("a quién se le avisa", () => {
  it("a todos los dispositivos que tienen ese pase", async () => {
    // Una misma persona puede tener la tarjeta en el iPhone y en el Apple Watch.
    const { client, enviados } = stubApns();
    await levantar(client);
    await cargarCertificado();
    await registrar("iphone", "push-iphone");
    await registrar("watch", "push-watch");

    const res = await empujar();

    expect(res.json()).toMatchObject({ sent: 2, dropped: 0, failed: 0 });
    expect(enviados.map((e) => e.token).sort()).toEqual(["push-iphone", "push-watch"]);
    expect(enviados[0]?.passType).toBe(PASS_TYPE);
  });

  it("no manda nada si no hay dispositivos registrados", async () => {
    const { client, enviados } = stubApns();
    await levantar(client);
    await cargarCertificado();

    expect((await empujar()).json()).toMatchObject({ sent: 0 });
    expect(enviados).toHaveLength(0);
  });

  it("no intenta mandar si el comercio no tiene certificado", async () => {
    // Sin material de firma no hay con qué autenticarse contra Apple. Se informa
    // en vez de intentar y fallar N veces.
    const { client, enviados } = stubApns();
    await levantar(client);
    await registrar("iphone", "push-iphone");

    expect((await empujar()).json()).toMatchObject({ sent: 0, skipped: true });
    expect(enviados).toHaveLength(0);
  });
});

describe("tokens que Apple rechaza", () => {
  it("borra el registro cuando el pase ya no está en el dispositivo", async () => {
    // Insistir contra un token muerto es lo que dispara el throttling de Apple,
    // y el emisor es uno solo para todo el ecosistema: el castigo lo pagarían
    // todos los comercios.
    const { client } = stubApns((token) =>
      token === "push-muerto" ? { status: "unregistered" } : { status: "sent" },
    );
    await levantar(client);
    await cargarCertificado();
    await registrar("viejo", "push-muerto");
    await registrar("nuevo", "push-vivo");

    expect((await empujar()).json()).toMatchObject({ sent: 1, dropped: 1 });
    expect((await registros()).map((r) => r.push_token)).toEqual(["push-vivo"]);
  });

  it("un fallo transitorio no borra el registro", async () => {
    // Apple caído no significa que el cliente borró la tarjeta. Borrar acá haría
    // que ese dispositivo no reciba nunca más un aviso.
    const { client } = stubApns(() => ({ status: "failed", reason: "ServiceUnavailable" }));
    await levantar(client);
    await cargarCertificado();
    await registrar("iphone", "push-iphone");

    expect((await empujar()).json()).toMatchObject({ sent: 0, failed: 1, dropped: 0 });
    expect(await registros()).toHaveLength(1);
  });
});

describe("aviso automático al acumular", () => {
  it("una acumulación dispara el push sola", async () => {
    const { client, enviados } = stubApns();
    await levantar(client);
    await cargarCertificado();
    await registrar("iphone", "push-iphone");

    const token = (
      await app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: { grant_type: "client_credentials", client_id: "cid", client_secret: "sec" },
      })
    ).json().access_token;

    await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merchant: "r-1",
        type: "order.paid",
        idempotencyKey: "pedido-1",
        membership: { serial: SERIAL },
        amount: 50_000,
      },
    });

    // El envío es fire-and-forget: no se espera a propósito, porque una caída de
    // Apple no puede hacer fallar una acumulación que el cliente ya se ganó.
    for (let i = 0; i < 40 && enviados.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.token).toBe("push-iphone");
  });

  it("una caída de Apple no rompe la acumulación", async () => {
    const { client } = stubApns(() => {
      throw new Error("APNs caído");
    });
    await levantar(client);
    await cargarCertificado();
    await registrar("iphone", "push-iphone");

    const token = (
      await app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: { grant_type: "client_credentials", client_id: "cid", client_secret: "sec" },
      })
    ).json().access_token;

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merchant: "r-1",
        type: "order.paid",
        idempotencyKey: "pedido-2",
        membership: { serial: SERIAL },
        amount: 50_000,
      },
    });

    expect(res.statusCode).toBe(201);
    const [saldo] = await rows<{ balance: number }>(
      db.drizzle,
      sql`SELECT balance FROM membership WHERE id = ${membershipId}`,
    );
    expect(saldo!.balance).toBe(105);
  });
});
