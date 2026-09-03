/**
 * Alta automática del material de firma de un comercio.
 *
 * Hace de una sola vez lo que hoy son seis pasos manuales en el portal de
 * Apple: generar el par de claves, armar el CSR, registrar el Pass Type ID,
 * pedir el certificado, convertirlo a PEM y guardarlo cifrado.
 *
 * **La clave privada se genera acá y no sale nunca.** A Apple se le manda el
 * CSR, que es público; el certificado que devuelve tampoco es secreto. Lo único
 * sensible queda cifrado en la base con la misma clave que usa el resto del
 * material de firma.
 *
 * Es idempotente sobre el Pass Type ID: si ya existe, se reusa. Sobre el
 * certificado no lo es a propósito — pedir uno nuevo es exactamente lo que hay
 * que hacer para renovar, o para rotar uno comprometido.
 */

import { createSign, generateKeyPairSync } from "node:crypto";

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";
import { createAscClient, passTypeIdFor, type AscConfig } from "@sophos/passes";

import { storeCertificate } from "./apple.js";

/**
 * Pass Type IDs quemados: nunca hay que pedirle a Apple material nuevo para ellos.
 *
 * `don-julio` es el restaurante ficticio con el que se probó toda la capa de
 * Apple, y su clave privada quedó expuesta el 2026-09-01. **Apple no permite
 * revocar certificados de Pass Type ID** —ni por API ni por el portal, solo
 * abriendo un caso con soporte— así que ese identificador queda comprometido
 * para siempre: cualquiera con esa clave puede firmar pases a su nombre.
 *
 * El guard va acá y no en el alta de comercios porque un comercio llamado
 * don-julio en una base de pruebas no hace daño; lo que no puede pasar es que
 * un comercio real termine emitiendo tarjetas bajo ese identificador. Y va en
 * código y no en un documento: dentro de seis meses nadie va a releer el
 * documento.
 */
export const BURNED_PASS_TYPE_IDS = new Set(["pass.com.sophosgroup.l.don-julio"]);

export class BurnedIdentifierError extends Error {
  constructor(readonly passTypeIdentifier: string) {
    super(
      `${passTypeIdentifier} está comprometido y no se puede usar para un comercio real. ` +
        "Su clave privada se filtró y Apple no permite revocar el certificado.",
    );
    this.name = "BurnedIdentifierError";
  }
}

export interface ProvisionResult {
  passTypeIdentifier: string;
  /** `true` si el Pass Type ID ya existía y se reusó. */
  reused: boolean;
  expiresAt: Date;
}

/**
 * Genera un par RSA y su CSR.
 *
 * Apple firma certificados de Pass Type ID sobre RSA de 2048 bits. El CSR lleva
 * el mínimo: el nombre común identifica al comercio dentro de la cuenta, y todo
 * lo demás lo completa Apple al emitir.
 */
export function generateCsr(commonName: string): { privateKeyPem: string; csrPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const csrPem = buildCsr(commonName, publicKey, privateKey);
  return { privateKeyPem: privateKey, csrPem };
}

export interface ProvisionInput {
  merchantId: string;
  /** Slug del comercio. Define el Pass Type ID y no se puede cambiar después. */
  slug: string;
  /** Nombre visible en el portal de Apple. */
  displayName: string;
}

export async function provisionPassCertificate(
  db: Db,
  input: ProvisionInput,
  asc: AscConfig,
  encryptionKey: Buffer,
  /** Inyectable para los tests: el real crea certificados de verdad en la cuenta. */
  fetchImpl?: typeof fetch,
): Promise<ProvisionResult> {
  const client = createAscClient(asc, fetchImpl);
  const identifier = passTypeIdFor(input.slug);

  if (BURNED_PASS_TYPE_IDS.has(identifier)) throw new BurnedIdentifierError(identifier);

  const existente = await client.findPassTypeId(identifier);
  const passType =
    existente ?? (await client.createPassTypeId(identifier, `Sophos Loyalty ${input.displayName}`));

  const { privateKeyPem, csrPem } = generateCsr(`Sophos Loyalty ${input.displayName}`);
  const certificatePem = await client.createCertificate(passType.id, csrPem);

  const { expiresAt } = await storeCertificate(
    db,
    {
      merchantId: input.merchantId,
      passTypeIdentifier: identifier,
      certificatePem,
      privateKeyPem,
    },
    encryptionKey,
  );

  return { passTypeIdentifier: identifier, reused: existente !== null, expiresAt };
}

/** Comercio del que hace falta el slug y el nombre para provisionar. */
export async function merchantForProvisioning(
  db: Db,
  merchantId: string,
): Promise<{ slug: string; displayName: string } | null> {
  const found = await rows<{ slug: string; display_name: string }>(
    db.drizzle,
    sql`SELECT slug, display_name FROM merchant WHERE id = ${merchantId}`,
  );
  const row = found[0];
  return row ? { slug: row.slug, displayName: row.display_name } : null;
}

/** Lo que se pierde si se borra un comercio. */
export interface MerchantFootprint {
  slug: string;
  displayName: string;
  productSlug: string;
  cards: number;
  outstanding: number;
  ledgerEntries: number;
  passes: number;
  hasCertificate: boolean;
}

/**
 * Qué se lleva puesto el borrado de un comercio.
 *
 * Se consulta **antes** de borrar y se devuelve **después**. Un borrado que
 * contesta "ok" no deja ver si se acaba de tirar un comercio de prueba vacío o
 * la base de clientes de un restaurante que factura.
 */
export async function merchantFootprint(
  db: Db,
  merchantId: string,
): Promise<MerchantFootprint | null> {
  const found = await rows<{
    slug: string;
    display_name: string;
    product_slug: string;
    cards: number;
    outstanding: number;
    ledger_entries: number;
    passes: number;
    has_certificate: boolean;
  }>(
    db.drizzle,
    sql`SELECT m.slug, m.display_name, p.slug AS product_slug,
               (SELECT count(*)::int FROM membership ms WHERE ms.merchant_id = m.id) AS cards,
               (SELECT COALESCE(sum(ms.balance), 0)::int FROM membership ms
                 WHERE ms.merchant_id = m.id) AS outstanding,
               (SELECT count(*)::int FROM ledger_entry le
                  JOIN membership ms ON ms.id = le.membership_id
                 WHERE ms.merchant_id = m.id) AS ledger_entries,
               (SELECT count(*)::int FROM pass_instance pi
                  JOIN membership ms ON ms.id = pi.membership_id
                 WHERE ms.merchant_id = m.id) AS passes,
               EXISTS (SELECT 1 FROM pass_certificate pc
                        WHERE pc.merchant_id = m.id) AS has_certificate
          FROM merchant m
          JOIN product p ON p.id = m.product_id
         WHERE m.id = ${merchantId}`,
  );

  const row = found[0];
  if (!row) return null;

  return {
    slug: row.slug,
    displayName: row.display_name,
    productSlug: row.product_slug,
    cards: row.cards,
    outstanding: row.outstanding,
    ledgerEntries: row.ledger_entries,
    passes: row.passes,
    hasCertificate: row.has_certificate,
  };
}

/**
 * Borra un comercio y **todo** lo que cuelga de él.
 *
 * Existe para limpiar comercios de prueba, que se acumulan solos mientras se
 * integra un producto nuevo. El `ON DELETE CASCADE` del esquema se lleva el
 * programa, las membresías, los pases emitidos y las notificaciones.
 *
 * **Solo funciona sobre comercios sin historia contable.** Si movió puntos, el
 * trigger `ledger_entry_immutable` rechaza el borrado a nivel base y el DELETE
 * falla entero. Eso no es un obstáculo a sortear: es la garantía de que el
 * saldo de un cliente siempre se puede reconstruir. Se comprueba antes para
 * poder explicarlo, en vez de devolver un error de Postgres.
 *
 * El `person` sobrevive: es identidad global compartida y puede tener tarjetas
 * en otros comercios. Lo que se borra es la relación con **este**.
 *
 * `confirmSlug` no es ceremonia: el id es un uuid y un uuid equivocado es
 * indistinguible del correcto a simple vista. Escribir el slug obliga a mirar
 * qué se está por borrar, que es la única defensa real contra borrar el
 * comercio de al lado en la lista.
 */
export class MerchantDeleteError extends Error {
  constructor(
    readonly code: "not_found" | "slug_mismatch" | "has_ledger",
    message: string,
    readonly footprint?: MerchantFootprint,
  ) {
    super(message);
    this.name = "MerchantDeleteError";
  }
}

export async function deleteMerchant(
  db: Db,
  merchantId: string,
  confirmSlug: string,
): Promise<MerchantFootprint> {
  const footprint = await merchantFootprint(db, merchantId);
  if (!footprint) {
    throw new MerchantDeleteError("not_found", "No existe un comercio con ese id.");
  }

  if (confirmSlug !== footprint.slug) {
    throw new MerchantDeleteError(
      "slug_mismatch",
      `Para borrar "${footprint.displayName}" hay que confirmar su slug exacto: ${footprint.slug}.`,
      footprint,
    );
  }

  // Un comercio que movió puntos tiene historia contable, y el trigger
  // `ledger_entry_immutable` la protege a nivel base: el CASCADE choca contra
  // él y el DELETE falla entero.
  //
  // Se podría desactivar el trigger para pasar por arriba. No se hace: una
  // garantía que la propia API sabe saltear no es una garantía, y el día que
  // un comercio discuta el saldo de un cliente lo único que hay para mostrar
  // es este ledger. Borrar historia real queda como una operación deliberada
  // contra la base, hecha por una persona que sabe qué está desactivando —
  // nunca como un botón del back-office.
  if (footprint.ledgerEntries > 0) {
    throw new MerchantDeleteError(
      "has_ledger",
      `"${footprint.displayName}" tiene ${footprint.ledgerEntries} asiento(s) en el ledger y ` +
        `${footprint.outstanding} punto(s) en circulación. El ledger es append-only: no se borra ` +
        "desde acá. Si de verdad es data de prueba, hay que hacerlo contra la base a mano.",
      footprint,
    );
  }

  await rows(db.drizzle, sql`DELETE FROM merchant WHERE id = ${merchantId}`);
  return footprint;
}

// ---------------------------------------------------------------------------
// Construcción del CSR
//
// Node no trae generación de CSR y traer una librería de ASN.1 para armar una
// estructura de veinte bytes sería desproporcionado. Un CSR es una secuencia
// DER simple: la información de la petición, el algoritmo de firma, y la firma
// de esa información.
// ---------------------------------------------------------------------------

/** Longitud en DER: corta hasta 127, y con prefijo de largo por encima. */
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);

  const bytes: number[] = [];
  let resto = n;
  while (resto > 0) {
    bytes.unshift(resto & 0xff);
    resto >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const SEQUENCE = 0x30;
const SET = 0x31;
const BIT_STRING = 0x03;
const NULL = 0x05;
const OID = 0x06;
const UTF8_STRING = 0x0c;
const INTEGER = 0x02;

/** OID 2.5.4.3 — commonName. */
const OID_COMMON_NAME = Buffer.from([0x55, 0x04, 0x03]);
/** OID 1.2.840.113549.1.1.11 — sha256WithRSAEncryption. */
const OID_SHA256_RSA = Buffer.from([
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b,
]);

function buildCsr(commonName: string, publicKeyDer: Buffer, privateKeyPem: string): string {
  const nombre = derTag(
    SEQUENCE,
    derTag(
      SET,
      derTag(
        SEQUENCE,
        Buffer.concat([
          derTag(OID, OID_COMMON_NAME),
          derTag(UTF8_STRING, Buffer.from(commonName, "utf8")),
        ]),
      ),
    ),
  );

  // La versión de un CSR es siempre 0, y el conjunto de atributos va vacío pero
  // presente: omitirlo produce un DER que Apple rechaza sin explicar.
  const certificationRequestInfo = derTag(
    SEQUENCE,
    Buffer.concat([
      derTag(INTEGER, Buffer.from([0x00])),
      nombre,
      publicKeyDer,
      derTag(0xa0, Buffer.alloc(0)),
    ]),
  );

  const firma = createSign("sha256").update(certificationRequestInfo).sign(privateKeyPem);

  const csr = derTag(
    SEQUENCE,
    Buffer.concat([
      certificationRequestInfo,
      derTag(SEQUENCE, Buffer.concat([derTag(OID, OID_SHA256_RSA), derTag(NULL, Buffer.alloc(0))])),
      // El bit string lleva un byte inicial que dice cuántos bits sobran: cero,
      // porque una firma RSA siempre ocupa bytes enteros.
      derTag(BIT_STRING, Buffer.concat([Buffer.from([0x00]), firma])),
    ]),
  );

  const lineas = csr.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lineas.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
}
