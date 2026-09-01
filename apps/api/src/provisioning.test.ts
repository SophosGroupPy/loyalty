/**
 * Alta automática del material de firma.
 *
 * El CSR se arma a mano en DER, así que se valida con `openssl` y no con este
 * mismo código: un CSR malformado lo rechaza Apple con un error que no explica
 * nada, y descubrirlo ahí sale caro.
 *
 * Las llamadas a Apple van contra un `fetch` inyectado. Contra la API real solo
 * se probó una vez, a mano, provisionando don-julio — no se puede dejar en la
 * suite algo que crea certificados de verdad en la cuenta cada vez que corre.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";
import { AscError, createAscClient, derToPem } from "@sophos/passes";

import { loadSigningMaterial } from "./apple.js";
import { generateCsr, provisionPassCertificate } from "./provisioning.js";
import { encryptionKeyFrom } from "./secrets.js";

let db: Db;
let merchantId: string;
const clave = encryptionKeyFrom(randomBytes(32).toString("hex"))!;

/** Certificado real, para que lo que devuelve el Apple falso sea creíble. */
function certificadoDe(csrPem: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ca-"));
  writeFileSync(join(dir, "req.csr"), csrPem);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "400",
    "-keyout", join(dir, "ca.key"), "-out", join(dir, "ca.pem"),
    "-subj", "/CN=Apple WWDR CA de prueba",
  ], { stdio: "ignore" });

  execFileSync("openssl", [
    "x509", "-req", "-in", join(dir, "req.csr"),
    "-CA", join(dir, "ca.pem"), "-CAkey", join(dir, "ca.key"),
    "-CAcreateserial", "-days", "395", "-out", join(dir, "out.pem"),
  ], { stdio: "ignore" });

  const pem = execFileSync("cat", [join(dir, "out.pem")], { encoding: "utf8" });
  // Apple devuelve DER en base64; se replica eso para ejercitar la conversión.
  return pem.replace(/-----[^-]+-----|\s/g, "");
}

/** App Store Connect falso. Registra qué se le pidió. */
function apple(opts: { existente?: boolean } = {}) {
  const llamadas: { method: string; path: string; body?: any }[] = [];

  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://api.appstoreconnect.apple.com/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    llamadas.push({ method: init?.method ?? "GET", path, body });

    if (path.startsWith("/passTypeIds") && (init?.method ?? "GET") === "GET") {
      return Response.json({
        data: opts.existente
          ? [{ id: "YAEXISTIA", attributes: { identifier: "pass.com.sophosgroup.l.don-julio", name: "x" } }]
          : [],
      });
    }
    if (path === "/passTypeIds") {
      return Response.json({
        data: { id: "NUEVO", attributes: { identifier: body.data.attributes.identifier, name: body.data.attributes.name } },
      });
    }
    if (path === "/certificates") {
      return Response.json({
        data: { id: "CERT", attributes: { certificateContent: certificadoDe(body.data.attributes.csrContent) } },
      });
    }
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, llamadas };
}

/** Clave EC real: el cliente firma un JWT ES256 antes de cada llamada. */
const asc = {
  keyId: "K",
  issuerId: "I",
  privateKeyPem: generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
};

beforeEach(async () => {
  db = await createTestDb();
  const [p] = await rows<{ id: string }>(db.drizzle,
    sql`INSERT INTO product (slug,name,client_id,client_secret_hash) VALUES ('elmenu','ElMenu','c','h') RETURNING id`);
  const [m] = await rows<{ id: string }>(db.drizzle,
    sql`INSERT INTO merchant (product_id,external_id,slug,legal_name,display_name)
        VALUES (${p!.id},'r-1','don-julio','Don Julio SA','Don Julio') RETURNING id`);
  merchantId = m!.id;
});

afterEach(async () => { await db.close(); });

// ---------------------------------------------------------------------------

describe("el CSR", () => {
  it("openssl lo lee y su firma verifica", () => {
    const { csrPem } = generateCsr("Sophos Loyalty Don Julio");
    const dir = mkdtempSync(join(tmpdir(), "csr-"));
    writeFileSync(join(dir, "r.csr"), csrPem);

    const subject = execFileSync("openssl", ["req", "-in", join(dir, "r.csr"), "-noout", "-subject"], { encoding: "utf8" });
    expect(subject).toContain("Sophos Loyalty Don Julio");

    const verify = execFileSync("openssl", ["req", "-in", join(dir, "r.csr"), "-noout", "-verify"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(verify).toMatch(/verify OK/i);
  });

  it("su clave pública es la de la clave privada que devuelve", () => {
    // Si no coincidieran, Apple emitiría un certificado que no sirve para firmar
    // y el error aparecería recién en un iPhone.
    const { csrPem, privateKeyPem } = generateCsr("Prueba");
    const dir = mkdtempSync(join(tmpdir(), "par-"));
    writeFileSync(join(dir, "r.csr"), csrPem);
    writeFileSync(join(dir, "k.pem"), privateKeyPem);

    const delCsr = execFileSync("openssl", ["req", "-in", join(dir, "r.csr"), "-noout", "-pubkey"], { encoding: "utf8" });
    const deLaClave = execFileSync("openssl", ["pkey", "-in", join(dir, "k.pem"), "-pubout"], { encoding: "utf8" });
    expect(delCsr.trim()).toBe(deLaClave.trim());
  });

  it("cada llamada genera una clave distinta", () => {
    expect(generateCsr("A").privateKeyPem).not.toBe(generateCsr("A").privateKeyPem);
  });
});

describe("conversión del certificado", () => {
  it("arma un PEM que openssl entiende", () => {
    const der = certificadoDe(generateCsr("Prueba").csrPem);
    const dir = mkdtempSync(join(tmpdir(), "pem-"));
    writeFileSync(join(dir, "c.pem"), derToPem(der));

    expect(
      execFileSync("openssl", ["x509", "-in", join(dir, "c.pem"), "-noout", "-subject"], { encoding: "utf8" }),
    ).toContain("Prueba");
  });
});

describe("provisionar un comercio", () => {
  it("crea el Pass Type ID, pide el certificado y lo guarda cifrado", async () => {
    const { fetchImpl, llamadas } = apple();

    const r = await provisionPassCertificate(
      db, { merchantId, slug: "don-julio", displayName: "Don Julio" }, asc, clave, fetchImpl,
    );

    expect(r.passTypeIdentifier).toBe("pass.com.sophosgroup.l.don-julio");
    expect(r.reused).toBe(false);
    expect(llamadas.some((l) => l.method === "POST" && l.path === "/passTypeIds")).toBe(true);
    expect(llamadas.some((l) => l.method === "POST" && l.path === "/certificates")).toBe(true);

    // La clave privada nunca sale en claro de la base.
    const [row] = await rows<{ ct: Buffer }>(db.drizzle,
      sql`SELECT private_key_ciphertext AS ct FROM pass_certificate`);
    expect(Buffer.from(row!.ct).toString("utf8")).not.toContain("PRIVATE KEY");

    // Y el material guardado sirve: certificado y clave se corresponden.
    const material = await loadSigningMaterial(db, r.passTypeIdentifier, clave, "");
    expect(material).not.toBeNull();
    expect(material!.privateKeyPem).toContain("PRIVATE KEY");
  });

  it("reusa el Pass Type ID si ya existe", async () => {
    // Renovar un certificado no puede crear un identificador nuevo: cambiaría
    // el Pass Type ID y dejaría huérfanos todos los pases ya emitidos.
    const { fetchImpl, llamadas } = apple({ existente: true });

    const r = await provisionPassCertificate(
      db, { merchantId, slug: "don-julio", displayName: "Don Julio" }, asc, clave, fetchImpl,
    );

    expect(r.reused).toBe(true);
    expect(llamadas.filter((l) => l.method === "POST" && l.path === "/passTypeIds")).toHaveLength(0);
  });
});

describe("errores de Apple", () => {
  it("conserva el detalle, que es lo único que explica el rechazo", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { errors: [{ title: "Entity Error", detail: "El identificador ya está en uso." }] },
        { status: 409 },
      ),
    ) as unknown as typeof fetch;

    const client = createAscClient(asc, fetchImpl);
    await expect(client.listPassTypeIds()).rejects.toMatchObject({
      status: 409,
      detail: "El identificador ya está en uso.",
    });
    await expect(client.listPassTypeIds()).rejects.toBeInstanceOf(AscError);
  });
});
