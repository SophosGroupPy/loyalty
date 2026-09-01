/**
 * Emisión del `.pkpass` desde la API, con material de firma guardado cifrado.
 *
 * El certificado de los tests se genera acá: depender del certificado real de
 * Apple haría que la suite dejara de correr el día que vence, y ese día sería
 * dentro de un año, sin aviso.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import forge from "node-forge";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";
import { solidPng } from "@sophos/passes";

import { passAuthToken } from "./apple.js";
import { hashSecret } from "./auth.js";
import { encryptionKeyFrom, open, seal } from "./secrets.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("clave-de-test-que-no-va-a-produccion");
const ENCRYPTION_KEY = randomBytes(32).toString("hex");
const PASS_TYPE = "pass.com.sophosgroup.l.don-julio";
const SERIAL = "SN-DON-JULIO-1";

let db: Db;
let app: FastifyInstance;
let merchantId: string;
let signer: { certificatePem: string; privateKeyPem: string };
let wwdrPem: string;

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
  wwdrPem = makeCert("Apple Worldwide Developer Relations CA").certificatePem;
});

beforeEach(async () => {
  db = await createTestDb();
  app = createServer({
    db,
    signingKey: SIGNING_KEY,
    adminKey: "admin-de-test",
    appleWallet: {
      teamIdentifier: "3W23SYPG6H",
      webServiceURL: "https://tarjeta.sophosgroup.com.py",
      encryptionKey: ENCRYPTION_KEY,
      wwdrCertificatePem: wwdrPem,
    },
  });
  await app.ready();

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
        VALUES (${merchantId}, 'points', ${JSON.stringify({ earn: [] })}::jsonb, 'active')
        RETURNING id`,
  );
  await rows(
    db.drizzle,
    sql`INSERT INTO membership (person_id, program_id, merchant_id, serial_number, balance, tier)
        VALUES (${person!.id}, ${program!.id}, ${merchantId}, ${SERIAL}, 340, 'Oro')`,
  );
});

afterEach(async () => {
  await app.close();
  await db.close();
});

/** El back-office no usa la clave directo: se canjea por una sesión. */
async function adminToken(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/session",
    payload: { key: "admin-de-test", operator: "test" },
  });
  return res.json().token;
}

const admin = async (method: "GET" | "PUT", url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await adminToken()}` },
    ...(payload ? { payload: payload as object } : {}),
  });

const cargarCertificado = () =>
  admin("PUT", `/admin/merchants/${merchantId}/pass-certificate`, {
    passTypeIdentifier: PASS_TYPE,
    certificatePem: signer.certificatePem,
    privateKeyPem: signer.privateKeyPem,
  });

/** Lista los archivos del `.pkpass` que devolvió la API. */
function listar(res: { rawPayload: Buffer }): string {
  const dir = mkdtempSync(join(tmpdir(), "pkpass-ls-"));
  writeFileSync(join(dir, "p.pkpass"), res.rawPayload);
  return execFileSync("unzip", ["-Z1", join(dir, "p.pkpass")], { encoding: "utf8" });
}

const conLogoUrl = () =>
  rows(
    db.drizzle,
    sql`UPDATE merchant SET design = jsonb_set(COALESCE(design, '{}'::jsonb), '{logoUrl}',
        '"https://ejemplo.com/logo.png"') WHERE id = ${merchantId}`,
  );

/** Levanta un servidor con un `fetch` controlado, para el logo. */
async function conFetch(fetchImpl: typeof fetch) {
  const server = createServer({
    db,
    signingKey: SIGNING_KEY,
    adminKey: "admin-de-test",
    fetchImpl,
    appleWallet: {
      teamIdentifier: "3W23SYPG6H",
      webServiceURL: "https://tarjeta.sophosgroup.com.py",
      encryptionKey: ENCRYPTION_KEY,
      wwdrCertificatePem: wwdrPem,
    },
  });
  await server.ready();

  const res = await server.inject({
    method: "GET",
    url: `/apple/v1/passes/${PASS_TYPE}/${SERIAL}`,
    headers: { authorization: `ApplePass ${passAuthToken(SERIAL, SIGNING_KEY)}` },
  });
  await server.close();
  return res;
}

const pedirPase = (serial = SERIAL) =>
  app.inject({
    method: "GET",
    url: `/apple/v1/passes/${PASS_TYPE}/${serial}`,
    headers: { authorization: `ApplePass ${passAuthToken(serial, SIGNING_KEY)}` },
  });

// ---------------------------------------------------------------------------

describe("cifrado de la clave privada", () => {
  it("ida y vuelta con la misma clave", () => {
    const key = encryptionKeyFrom(ENCRYPTION_KEY)!;
    const sealed = seal("clave-privada-secreta", key);
    expect(open(sealed, key)).toBe("clave-privada-secreta");
  });

  it("no descifra con otra clave", () => {
    const key = encryptionKeyFrom(ENCRYPTION_KEY)!;
    const otra = encryptionKeyFrom(randomBytes(32).toString("hex"))!;
    expect(() => open(seal("secreto", key), otra)).toThrow(/no corresponde/);
  });

  it("detecta que el texto cifrado fue alterado", () => {
    // Sin autenticación esto devolvería basura y firmaríamos con una clave
    // corrupta. Con GCM falla de entrada.
    const key = encryptionKeyFrom(ENCRYPTION_KEY)!;
    const sealed = seal("secreto", key);
    sealed.ciphertext[0] = (sealed.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => open(sealed, key)).toThrow(/alterado/);
  });

  it("rechaza una clave que no tenga 32 bytes", () => {
    expect(() => encryptionKeyFrom("corta")).toThrow(/32 bytes/);
  });
});

describe("carga del certificado", () => {
  it("lo guarda y lee el vencimiento del propio certificado", async () => {
    const res = await cargarCertificado();
    expect(res.statusCode).toBe(200);
    expect(new Date(res.json().expiresAt).getFullYear()).toBe(2030);
  });

  it("nunca guarda la clave privada en claro", async () => {
    await cargarCertificado();

    const [row] = await rows<{ ct: Buffer }>(
      db.drizzle,
      sql`SELECT private_key_ciphertext AS ct FROM pass_certificate`,
    );
    expect(Buffer.from(row!.ct).toString("utf8")).not.toContain("PRIVATE KEY");
  });

  it("rechaza un certificado que no corresponde a la clave", async () => {
    // Se guardaría bien, todo parecería andar, y los pases saldrían con una
    // firma que iOS rechaza sin decir por qué.
    const otro = makeCert("Pass Type ID: otro");
    const res = await admin("PUT", `/admin/merchants/${merchantId}/pass-certificate`, {
      passTypeIdentifier: PASS_TYPE,
      certificatePem: otro.certificatePem,
      privateKeyPem: signer.privateKeyPem,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/no corresponde/);
  });

  it("renovar reemplaza en vez de acumular", async () => {
    await cargarCertificado();
    await cargarCertificado();

    const todos = await rows<{ id: string }>(db.drizzle, sql`SELECT id FROM pass_certificate`);
    expect(todos).toHaveLength(1);
  });

  it("avisa de los certificados por vencer", async () => {
    await cargarCertificado();

    const lejos = await admin("GET", "/admin/pass-certificates/expiring?days=30");
    expect(lejos.json().certificates).toHaveLength(0);

    const todos = await admin("GET", "/admin/pass-certificates/expiring?days=9999");
    expect(todos.json().certificates[0].passTypeIdentifier).toBe(PASS_TYPE);
  });
});

describe("emisión del pase", () => {
  it("503 mientras el comercio no tenga certificado", async () => {
    const res = await pedirPase();
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("apple_no_certificate");
  });

  it("emite un .pkpass que openssl valida contra el certificado guardado", async () => {
    await cargarCertificado();

    const res = await pedirPase();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.apple.pkpass");
    expect(res.headers["last-modified"]).toBeTypeOf("string");

    const dir = mkdtempSync(join(tmpdir(), "pkpass-api-"));
    writeFileSync(join(dir, "p.pkpass"), res.rawPayload);

    expect(execFileSync("unzip", ["-t", join(dir, "p.pkpass")], { encoding: "utf8" })).toContain(
      "No errors detected",
    );

    execFileSync("unzip", ["-qo", join(dir, "p.pkpass"), "-d", dir]);
    writeFileSync(join(dir, "signer.pem"), signer.certificatePem);
    const verificado = execFileSync(
      "openssl",
      [
        "smime", "-verify", "-binary", "-inform", "DER",
        "-in", join(dir, "signature"),
        "-content", join(dir, "manifest.json"),
        "-certfile", join(dir, "signer.pem"),
        "-noverify",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(verificado).toContain("pass.json");

    const pass = JSON.parse(
      execFileSync("unzip", ["-p", join(dir, "p.pkpass"), "pass.json"], { encoding: "utf8" }),
    );
    expect(pass.organizationName).toBe("Don Julio");
    expect(pass.teamIdentifier).toBe("3W23SYPG6H");
    expect(pass.storeCard.primaryFields[0].value).toBe(340);
    expect(pass.storeCard.secondaryFields[0].value).toBe("Oro");
  });

  it("el authenticationToken del pase emitido es el que valida el web service", async () => {
    // Si no coincidieran, el pase se agregaría y el registro fallaría con 401:
    // la tarjeta quedaría para siempre sin actualizarse.
    await cargarCertificado();
    const res = await pedirPase();

    const dir = mkdtempSync(join(tmpdir(), "pkpass-tok-"));
    writeFileSync(join(dir, "p.pkpass"), res.rawPayload);
    const pass = JSON.parse(
      execFileSync("unzip", ["-p", join(dir, "p.pkpass"), "pass.json"], { encoding: "utf8" }),
    );

    const registro = await app.inject({
      method: "POST",
      url: `/apple/v1/devices/dev-1/registrations/${PASS_TYPE}/${SERIAL}`,
      headers: { authorization: `ApplePass ${pass.authenticationToken}` },
      payload: { pushToken: "push-abc" },
    });
    expect(registro.statusCode).toBe(201);
  });

  it("incluye icon.png aunque el comercio no haya cargado logo", async () => {
    // Sin icon.png iOS no agrega el pase, y no dice por qué.
    await cargarCertificado();
    const res = await pedirPase();

    const dir = mkdtempSync(join(tmpdir(), "pkpass-icon-"));
    writeFileSync(join(dir, "p.pkpass"), res.rawPayload);
    const listado = execFileSync("unzip", ["-Z1", join(dir, "p.pkpass")], { encoding: "utf8" });
    expect(listado).toContain("icon.png");
  });

  it("usa el logo del comercio cuando se puede bajar", async () => {
    await cargarCertificado();
    await rows(
      db.drizzle,
      sql`UPDATE merchant SET design = jsonb_set(COALESCE(design, '{}'::jsonb), '{logoUrl}',
          '"https://ejemplo.com/logo.png"') WHERE id = ${merchantId}`,
    );

    const res = await conFetch(async () => new Response(solidPng(120, "#00FF00"), { status: 200 }));
    const listado = listar(res);
    expect(listado).toContain("logo.png");
  });

  it("cae al ícono de respaldo si el logo pesa demasiado", async () => {
    // El pase se rebaja entero en cada cambio de saldo: su peso es tráfico
    // recurrente. Un logo enorme lo volvería inusable sin que nadie lo note.
    await cargarCertificado();
    await conLogoUrl();

    const gigante = Buffer.alloc(600 * 1024, 0);
    solidPng(8, "#FF0000").copy(gigante); // arranca como PNG válido
    const res = await conFetch(async () => new Response(gigante, { status: 200 }));

    expect(listar(res)).not.toContain("logo.png");
    expect(listar(res)).toContain("icon.png");
  });

  it("cae al ícono de respaldo si el archivo no es PNG", async () => {
    // Apple solo acepta PNG. Un JPG renombrado se agrega igual al zip y el pase
    // se rechaza en el teléfono sin explicación.
    await cargarCertificado();
    await conLogoUrl();

    const res = await conFetch(async () => new Response(Buffer.from("no soy un png"), { status: 200 }));
    expect(listar(res)).not.toContain("logo.png");
  });

  it("cae al ícono de respaldo si la URL del logo no responde", async () => {
    await cargarCertificado();
    await conLogoUrl();

    const res = await conFetch(async () => { throw new Error("sin red"); });
    expect(listar(res)).toContain("icon.png");
  });

  it("404 para un serial de otro comercio", async () => {
    await cargarCertificado();
    const res = await pedirPase("SN-INVENTADO");
    expect(res.statusCode).toBe(404);
  });

  it("exige la credencial del pase", async () => {
    await cargarCertificado();
    const res = await app.inject({
      method: "GET",
      url: `/apple/v1/passes/${PASS_TYPE}/${SERIAL}`,
    });
    expect(res.statusCode).toBe(401);
  });
});
