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
import {
  asciiName,
  BurnedIdentifierError,
  deleteMerchant,
  generateCsr,
  merchantFootprint,
  MerchantDeleteError,
  provisionPassCertificate,
  provisionPendingCertificates,
  retryDelayMs,
} from "./provisioning.js";
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
          ? [{ id: "YAEXISTIA", attributes: { identifier: "pass.com.sophosgroup.l.la-vecina", name: "x" } }]
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
        VALUES (${p!.id},'r-1','la-vecina','La Vecina SRL','La Vecina') RETURNING id`);
  merchantId = m!.id;
});

afterEach(async () => { await db.close(); });

// ---------------------------------------------------------------------------

describe("el CSR", () => {
  it("openssl lo lee y su firma verifica", () => {
    const { csrPem } = generateCsr("Sophos Loyalty La Vecina");
    const dir = mkdtempSync(join(tmpdir(), "csr-"));
    writeFileSync(join(dir, "r.csr"), csrPem);

    const subject = execFileSync("openssl", ["req", "-in", join(dir, "r.csr"), "-noout", "-subject"], { encoding: "utf8" });
    expect(subject).toContain("Sophos Loyalty La Vecina");

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
      db, { merchantId, slug: "la-vecina", displayName: "La Vecina" }, asc, clave, fetchImpl,
    );

    expect(r.passTypeIdentifier).toBe("pass.com.sophosgroup.l.la-vecina");
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
      db, { merchantId, slug: "la-vecina", displayName: "La Vecina" }, asc, clave, fetchImpl,
    );

    expect(r.reused).toBe(true);
    expect(llamadas.filter((l) => l.method === "POST" && l.path === "/passTypeIds")).toHaveLength(0);
  });
});

describe("identificadores quemados", () => {
  it("no provisiona material nuevo para un Pass Type ID comprometido", async () => {
    // don-julio se usó para probar toda la capa de Apple y su clave privada se
    // filtró. Apple no deja revocar ese certificado, así que el identificador
    // queda inutilizable: cualquiera con esa clave puede firmar a su nombre.
    const { fetchImpl, llamadas } = apple();

    await expect(
      provisionPassCertificate(
        db, { merchantId, slug: "don-julio", displayName: "Don Julio" }, asc, clave, fetchImpl,
      ),
    ).rejects.toBeInstanceOf(BurnedIdentifierError);

    // Y no llega a hablar con Apple: se corta antes.
    expect(llamadas).toHaveLength(0);
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

// ---------------------------------------------------------------------------

describe("borrado de un comercio", () => {
  /** Deja el comercio con una tarjeta, saldo y un asiento en el ledger. */
  async function conUnCliente(opts: { conLedger?: boolean } = {}): Promise<void> {
    const [person] = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO person (phone_e164, consent_version, phone_verified_at)
          VALUES ('+595993427654', 'programa/v2', now()) RETURNING id`,
    );
    const [program] = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO program (merchant_id, kind, config, status)
          VALUES (${merchantId}, 'points', ${JSON.stringify({ earn: [] })}::jsonb, 'active')
          RETURNING id`,
    );
    const [ms] = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO membership (person_id, program_id, merchant_id, serial_number, balance)
          VALUES (${person!.id}, ${program!.id}, ${merchantId}, 'SN-1', 12) RETURNING id`,
    );
    if (opts.conLedger === false) return;

    await rows(
      db.drizzle,
      sql`INSERT INTO ledger_entry
            (membership_id, merchant_id, kind, amount, balance_after, business_day, reason)
          VALUES (${ms!.id}, ${merchantId}, 'earn', 12, 12, current_date, 'consumo')`,
    );
  }

  it("cuenta lo que se perdería antes de borrar nada", async () => {
    await conUnCliente();

    const f = await merchantFootprint(db, merchantId);

    expect(f).toMatchObject({
      slug: "la-vecina",
      displayName: "La Vecina",
      productSlug: "elmenu",
      cards: 1,
      outstanding: 12,
      ledgerEntries: 1,
      hasCertificate: false,
    });
  });

  it("no borra si el slug de confirmación no coincide", async () => {
    // El id es un uuid, y un uuid equivocado es indistinguible del correcto a
    // simple vista. Repetir el slug obliga a mirar qué se está por borrar.
    await conUnCliente();

    await expect(deleteMerchant(db, merchantId, "otro-comercio")).rejects.toBeInstanceOf(
      MerchantDeleteError,
    );

    const sigue = await rows(db.drizzle, sql`SELECT id FROM merchant WHERE id = ${merchantId}`);
    expect(sigue).toHaveLength(1);
  });

  it("se niega a borrar un comercio con historia en el ledger", async () => {
    // El ledger es append-only a nivel base: el trigger rechaza el DELETE y el
    // CASCADE falla entero. Se comprueba antes para poder explicar por qué, en
    // vez de escupir un error de Postgres.
    await conUnCliente();

    await expect(deleteMerchant(db, merchantId, "la-vecina")).rejects.toMatchObject({
      code: "has_ledger",
    });

    const sigue = await rows(db.drizzle, sql`SELECT id FROM merchant WHERE id = ${merchantId}`);
    expect(sigue).toHaveLength(1);
  });

  it("con el slug correcto borra un comercio sin movimientos", async () => {
    await conUnCliente({ conLedger: false });

    const borrado = await deleteMerchant(db, merchantId, "la-vecina");
    expect(borrado.cards).toBe(1);

    for (const tabla of ["merchant", "program", "membership"] as const) {
      const quedan = await rows(
        db.drizzle,
        tabla === "merchant"
          ? sql`SELECT id FROM merchant WHERE id = ${merchantId}`
          : tabla === "program"
            ? sql`SELECT id FROM program WHERE merchant_id = ${merchantId}`
            : sql`SELECT id FROM membership WHERE merchant_id = ${merchantId}`,
      );
      expect(quedan, `quedaron filas en ${tabla}`).toHaveLength(0);
    }

    // El ledger cuelga de membership, que ya no existe.
    const asientos = await rows(db.drizzle, sql`SELECT id FROM ledger_entry`);
    expect(asientos).toHaveLength(0);
  });

  it("la persona sobrevive: es identidad global, no del comercio", async () => {
    // Puede tener tarjeta en otros comercios. Lo que se borra es su relación
    // con este, no su registro.
    await conUnCliente({ conLedger: false });
    await deleteMerchant(db, merchantId, "la-vecina");

    const personas = await rows(db.drizzle, sql`SELECT id FROM person`);
    expect(personas).toHaveLength(1);
  });

  it("404 si el comercio no existe", async () => {
    await expect(
      deleteMerchant(db, "00000000-0000-0000-0000-000000000000", "lo-que-sea"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("nombres que Apple acepta", () => {
  it("translitera acentos en vez de borrarlos", () => {
    // Apple rechazó el alta de "DEMO ElMenú" entera. Un comercio paraguayo con
    // acento o eñe es el caso normal, no el raro.
    expect(asciiName("DEMO ElMenú")).toBe("DEMO ElMenu");
    expect(asciiName("Ñandutí")).toBe("Nanduti");
    expect(asciiName("Café Ámbar")).toBe("Cafe Ambar");
  });

  it("deja intacto lo que ya era ASCII", () => {
    expect(asciiName("Don Julio")).toBe("Don Julio");
  });

  it("nunca devuelve vacío", () => {
    // Apple rechaza el nombre vacío igual que rechazaba el acento.
    expect(asciiName("日本語")).toBe("comercio");
    expect(asciiName("   ")).toBe("comercio");
  });
});

// ---------------------------------------------------------------------------

describe("alta automática de los comercios pendientes", () => {
  /** Otro comercio en el mismo producto, sin certificado. */
  async function otroComercio(slug: string, nombre: string): Promise<string> {
    const [p] = await rows<{ id: string }>(
      db.drizzle,
      sql`SELECT id FROM product WHERE slug = 'elmenu'`,
    );
    const [m] = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
          VALUES (${p!.id}, ${"ext-" + slug}, ${slug}, ${nombre + " SRL"}, ${nombre})
          RETURNING id`,
    );
    return m!.id;
  }

  it("le da certificado al comercio que no lo tiene", async () => {
    const { fetchImpl } = apple();

    const r = await provisionPendingCertificates(db, asc, clave, { fetchImpl });

    expect(r.provisioned).toEqual(["la-vecina"]);
    expect(r.failed).toEqual([]);

    const material = await loadSigningMaterial(
      db, "pass.com.sophosgroup.l.la-vecina", clave, "",
    );
    expect(material).not.toBeNull();
  });

  it("no vuelve a pedirle a Apple por uno que ya tiene certificado", async () => {
    // Cada alta quema un Pass Type ID permanente. Repetir sería caro y sucio.
    const { fetchImpl } = apple();
    await provisionPendingCertificates(db, asc, clave, { fetchImpl });

    const { fetchImpl: segundo, llamadas } = apple();
    const r = await provisionPendingCertificates(db, asc, clave, { fetchImpl: segundo });

    expect(r.provisioned).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });

  it("un rechazo de Apple no frena a los demás comercios", async () => {
    await otroComercio("don-pedro", "Don Pedro");

    // Falla el primero que pida un certificado; el resto sigue.
    let primera = true;
    const { fetchImpl } = apple();
    const conFalla = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/certificates") && primera) {
        primera = false;
        return Response.json({ errors: [{ title: "Entity Error", detail: "nombre inválido" }] }, { status: 409 });
      }
      return (fetchImpl as any)(url, init);
    }) as unknown as typeof fetch;

    const r = await provisionPendingCertificates(db, asc, clave, { fetchImpl: conFalla });

    expect(r.provisioned).toHaveLength(1);
    expect(r.failed).toHaveLength(1);
  });

  it("un comercio que falla espera antes de reintentar", async () => {
    // Sin esto se reintentaría cada minuto contra una API con rate limit, y el
    // cupo que se gasta ahí lo pagan los comercios que sí se pueden provisionar.
    const rompe = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const ahora = new Date("2026-09-03T12:00:00Z");

    const r = await provisionPendingCertificates(db, asc, clave, {
      fetchImpl: rompe,
      now: () => ahora,
    });
    expect(r.failed).toHaveLength(1);

    const [fila] = await rows<{ attempts: number; last_error: string; next_attempt_at: Date }>(
      db.drizzle,
      sql`SELECT attempts, last_error, next_attempt_at FROM pass_provision_attempt`,
    );
    expect(fila!.attempts).toBe(1);
    expect(fila!.last_error).toBeTruthy();
    expect(new Date(fila!.next_attempt_at).getTime()).toBeGreaterThan(ahora.getTime());

    // En la vuelta inmediata ni se lo mira.
    const { fetchImpl, llamadas } = apple();
    const segunda = await provisionPendingCertificates(db, asc, clave, {
      fetchImpl,
      now: () => ahora,
    });
    expect(segunda.provisioned).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });

  it("la tanda tiene tope: no vacía la cuenta de Apple de una", async () => {
    await otroComercio("uno", "Uno");
    await otroComercio("dos", "Dos");

    const { fetchImpl } = apple();
    const r = await provisionPendingCertificates(db, asc, clave, { fetchImpl, max: 2 });

    expect(r.provisioned).toHaveLength(2);
    expect(r.pending).toBeGreaterThan(0);
  });

  it("la espera crece y tiene techo", () => {
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(3));
    expect(retryDelayMs(99)).toBe(6 * 60 * 60 * 1000);
  });
});
