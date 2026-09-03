/**
 * Emisión del `.pkpass` desde la API, con material de firma guardado cifrado.
 *
 * El certificado de los tests se genera acá: depender del certificado real de
 * Apple haría que la suite dejara de correr el día que vence, y ese día sería
 * dentro de un año, sin aviso.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

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

/**
 * Mide un PNG y comprueba que sus datos se puedan descomprimir.
 *
 * A mano y sin librería: el bug que motivó esto producía un PNG de 65 bytes con
 * cabecera plausible y datos basura, así que mirar solo el tamaño del archivo o
 * la firma no alcanza. `inflateSync` sobre el IDAT es lo que separa un PNG que
 * iOS abre de uno que rechaza.
 */
function medirPng(buf: Buffer): { ancho: number; alto: number } {
  expect(buf.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");

  const idat: Buffer[] = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const largo = buf.readUInt32BE(pos);
    const tipo = buf.subarray(pos + 4, pos + 8).toString("latin1");
    if (tipo === "IDAT") idat.push(buf.subarray(pos + 8, pos + 8 + largo));
    pos += 12 + largo;
  }

  expect(idat.length, "el PNG no tiene datos").toBeGreaterThan(0);
  // Tira si los datos están corruptos, que es exactamente el caso que se busca.
  inflateSync(Buffer.concat(idat));

  return { ancho: buf.readUInt32BE(16), alto: buf.readUInt32BE(20) };
}

/** Saca un archivo suelto del `.pkpass` para poder mirarlo de verdad. */
function extraer(res: { rawPayload: Buffer }, nombre: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "pkpass-x-"));
  writeFileSync(join(dir, "p.pkpass"), res.rawPayload);
  execFileSync("unzip", ["-qo", join(dir, "p.pkpass"), "-d", dir]);
  return readFileSync(join(dir, nombre));
}

const conBanda = () =>
  rows(
    db.drizzle,
    sql`UPDATE merchant SET design = jsonb_set(COALESCE(design, '{}'::jsonb), '{stripImageUrl}',
        '"https://ejemplo.com/banda.png"') WHERE id = ${merchantId}`,
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

  it("lista también los comercios que todavía no tienen certificado", async () => {
    // Un listado que solo muestre los cargados esconde justamente el problema:
    // los comercios que no pueden emitir en iPhone.
    const antes = await admin("GET", "/admin/pass-certificates");
    expect(antes.json().certificates).toHaveLength(1);
    expect(antes.json().certificates[0]).toMatchObject({
      merchantName: "Don Julio",
      productName: "ElMenu",
      passTypeIdentifier: null,
    });

    await cargarCertificado();

    const despues = await admin("GET", "/admin/pass-certificates");
    expect(despues.json().certificates[0].passTypeIdentifier).toBe(PASS_TYPE);
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

  it("la banda del comercio va adentro del .pkpass", async () => {
    // Esto se dio por hecho durante todo un deploy. `APPLE_STRIP_PX` no estaba
    // re-exportado desde el barrel: llegaba `undefined`, el achicado reventaba,
    // y el catch de `loadStrip` se tragaba el error y devolvía null. La tarjeta
    // salía sin banda y sin una sola línea de log que lo dijera.
    await cargarCertificado();
    await conBanda();

    // 1024 px fuerza el achicado, que es exactamente donde vivía el bug: con
    // una imagen chica el resize se saltea y el test pasaría igual roto.
    const res = await conFetch(async () => new Response(solidPng(1024, "#DC2626"), { status: 200 }));

    expect(res.statusCode).toBe(200);
    expect(listar(res)).toContain("strip.png");

    // Que el archivo esté no alcanza: el bug original metía en el zip un PNG
    // corrupto de 65 bytes, y un test de presencia lo daba por bueno. Lo que
    // hay que comprobar es que iOS lo pueda leer.
    expect(medirPng(extraer(res, "strip.png"))).toEqual({ ancho: 750, alto: 750 });
  });

  it("la banda sale aunque el comercio no haya cargado logo", async () => {
    // Son dos imágenes independientes: un local puede subir la foto de su salón
    // sin tener el logo en PNG. Estaban acopladas y nadie lo habría notado.
    await cargarCertificado();
    await conBanda();

    const res = await conFetch(async () => new Response(solidPng(1024, "#DC2626"), { status: 200 }));
    const archivos = listar(res);

    expect(archivos).toContain("strip.png");
    expect(archivos).not.toContain("logo.png");
  });

  it("el pase sale igual si la banda no se puede bajar", async () => {
    // Una banda caída no es motivo para dejar al cliente sin tarjeta.
    await cargarCertificado();
    await conBanda();

    const res = await conFetch(async () => new Response("", { status: 500 }));

    expect(res.statusCode).toBe(200);
    expect(listar(res)).not.toContain("strip.png");
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

// ---------------------------------------------------------------------------
// La descarga del cliente final, que es lo que hacía falta para que alguien
// pudiera instalar una tarjeta por primera vez
// ---------------------------------------------------------------------------

describe("descarga del pase por el cliente", () => {
  async function tokenProducto(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "client_credentials", client_id: "cid", client_secret: "sec" },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().access_token;
  }

  async function linkDeDescarga(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/passes/apple",
      headers: { authorization: `Bearer ${await tokenProducto()}` },
      payload: { merchant: "r-1", membership: { serial: SERIAL } },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().downloadUrl;
  }

  it("entrega el .pkpass a quien tenga el link, sin sesión", async () => {
    await cargarCertificado();
    const url = await linkDeDescarga();

    // El cliente nunca creó una cuenta: el token ES la credencial.
    const res = await app.inject({ method: "GET", url: new URL(url).pathname });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.apple.pkpass");
    // Un .pkpass es un ZIP: si no arranca con PK, iOS lo rechaza sin decir por qué.
    expect(res.rawPayload.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("no se cachea: el saldo cambia con cada consumo", async () => {
    await cargarCertificado();
    const res = await app.inject({ method: "GET", url: new URL(await linkDeDescarga()).pathname });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("el link para mandar por correo puede vivir más de una hora", async () => {
    await cargarCertificado();
    const res = await app.inject({
      method: "POST",
      url: "/v1/passes/apple",
      headers: { authorization: `Bearer ${await tokenProducto()}` },
      payload: {
        merchant: "r-1",
        membership: { serial: SERIAL },
        ttlSeconds: 7 * 24 * 3600,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().expiresIn).toBe(7 * 24 * 3600);
  });

  it("no se puede pedir un link eterno", async () => {
    // El tope existe para que un correo reenviado meses después no siga
    // entregando la tarjeta de otra persona.
    const res = await app.inject({
      method: "POST",
      url: "/v1/passes/apple",
      headers: { authorization: `Bearer ${await tokenProducto()}` },
      payload: {
        merchant: "r-1",
        membership: { serial: SERIAL },
        ttlSeconds: 365 * 24 * 3600,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("no entrega link si el comercio todavía no tiene certificado", async () => {
    // Sin cargarCertificado(): es el estado de todo comercio recién dado de alta.
    //
    // Antes contestaba 201 con un link que fallaba recién cuando el cliente lo
    // abría en su teléfono. El producto no tenía forma de saberlo, así que
    // dibujaba el botón de Apple igual — y cuando el link viajaba por correo, el
    // botón muerto le quedaba al cliente en la casilla.
    const res = await app.inject({
      method: "POST",
      url: "/v1/passes/apple",
      headers: { authorization: `Bearer ${await tokenProducto()}` },
      payload: { merchant: "r-1", membership: { serial: SERIAL } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("pass_not_provisioned");
  });

  it("el error que ve el cliente en el teléfono es una página, no un JSON", async () => {
    // Esta ruta la abre el navegador del cliente. Un {"error":"..."} a pantalla
    // completa lo deja pensando que se rompió su teléfono.
    const res = await app.inject({
      method: "GET",
      url: "/public/passes/no-es-un-token",
      headers: { accept: "text/html,application/xhtml+xml" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("El link venció");
    expect(res.body).not.toContain("invalid_token");
  });

  it("el monitoreo sigue recibiendo JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/public/passes/no-es-un-token" });
    expect(res.json().error).toBe("invalid_token");
  });

  it("un token inventado no sirve", async () => {
    await cargarCertificado();
    const res = await app.inject({ method: "GET", url: "/public/passes/no-es-un-token" });
    expect(res.statusCode).toBe(401);
  });

  it("un token firmado con otra clave no sirve", async () => {
    await cargarCertificado();
    const { issuePassDownloadToken } = await import("./auth.js");
    const { token } = await issuePassDownloadToken(
      new TextEncoder().encode("otra-clave-distinta-de-la-del-servidor"),
      "00000000-0000-0000-0000-000000000000",
    );
    const res = await app.inject({ method: "GET", url: `/public/passes/${token}` });
    expect(res.statusCode).toBe(401);
  });

  it("un token vencido no sirve", async () => {
    await cargarCertificado();
    const { issuePassDownloadToken } = await import("./auth.js");
    // TTL negativo: nace vencido. Es lo que evita que el link reenviado por
    // WhatsApp una semana después siga entregando la tarjeta de otro.
    const { token } = await issuePassDownloadToken(SIGNING_KEY, merchantId, -1);
    const res = await app.inject({ method: "GET", url: `/public/passes/${token}` });
    expect(res.statusCode).toBe(401);
  });

  it("un producto no puede pedir el link de una tarjeta de otro producto", async () => {
    await cargarCertificado();
    await rows(
      db.drizzle,
      sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
          VALUES ('noctu', 'Noctu', 'cid-noctu', ${await hashSecret("sec")})`,
    );
    const auth = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: { grant_type: "client_credentials", client_id: "cid-noctu", client_secret: "sec" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/passes/apple",
      headers: { authorization: `Bearer ${auth.json().access_token}` },
      payload: { merchant: "r-1", membership: { serial: SERIAL } },
    });
    expect(res.statusCode).toBe(403);
  });
});
