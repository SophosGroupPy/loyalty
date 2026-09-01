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
