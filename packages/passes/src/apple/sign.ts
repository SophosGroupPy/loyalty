/**
 * Manifiesto y firma del `.pkpass`.
 *
 * El paquete lleva un `manifest.json` con el hash de cada archivo, y un
 * `signature` que es una firma PKCS#7 separada de ese manifiesto. Así, cambiar
 * cualquier archivo cambia su hash, cambia el manifiesto e invalida la firma.
 *
 * **El manifiesto usa SHA-1 porque lo exige el formato de Apple, no porque lo
 * elijamos.** No es un problema: la integridad no la da el hash sino la firma
 * PKCS#7 sobre el manifiesto, hecha con SHA-256 y con el certificado del Pass
 * Type ID. Un atacante que quisiera aprovechar una colisión de SHA-1 tendría
 * que además volver a firmar el manifiesto, y para eso necesita la clave
 * privada — con la cual no le haría falta la colisión.
 */

import { createHash } from "node:crypto";
import forge from "node-forge";

import type { PassSigningMaterial } from "./types.js";

/**
 * Los OID de forge están tipados como opcionales aunque siempre existen. Se
 * resuelven acá para que el error, si alguna vez faltara uno, sea explícito y no
 * un `undefined` silencioso dentro de la estructura firmada.
 */
function oid(name: string): string {
  const value = forge.pki.oids[name];
  if (!value) throw new PassSigningError(`node-forge no conoce el OID ${name}.`);
  return value;
}

export interface PassFile {
  name: string;
  data: Buffer;
}

/** `manifest.json`: el SHA-1 de cada archivo del paquete, en hex. */
export function buildManifest(files: PassFile[]): Buffer {
  const manifest: Record<string, string> = {};
  for (const file of files) {
    manifest[file.name] = createHash("sha1").update(file.data).digest("hex");
  }
  // Con las claves ordenadas, dos paquetes con el mismo contenido dan el mismo
  // manifiesto byte a byte. Sin eso el orden depende de cómo se armó la lista.
  const ordered = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

export class PassSigningError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "PassSigningError";
  }
}

/**
 * Firma PKCS#7 separada del manifiesto, en DER.
 *
 * Separada («detached») quiere decir que la firma no incluye el contenido
 * firmado: el manifiesto ya viaja como archivo aparte dentro del zip, y
 * duplicarlo adentro de la firma es justamente lo que Apple no acepta.
 *
 * La cadena lleva el certificado del comercio y el intermedio WWDR de Apple. Si
 * falta el WWDR el pase se firma igual pero iOS lo rechaza al agregarlo, sin
 * decir por qué — es el error más caro de diagnosticar de toda la capa.
 */
export function signManifest(
  manifest: Buffer,
  material: PassSigningMaterial,
  signedAt?: Date,
): Buffer {
  let certificate: forge.pki.Certificate;
  let wwdr: forge.pki.Certificate;
  let privateKey: forge.pki.rsa.PrivateKey;

  try {
    certificate = forge.pki.certificateFromPem(material.certificatePem);
  } catch (error) {
    throw new PassSigningError("El certificado del Pass Type ID no es un PEM válido.", error);
  }

  try {
    wwdr = forge.pki.certificateFromPem(material.wwdrCertificatePem);
  } catch (error) {
    throw new PassSigningError("El certificado WWDR de Apple no es un PEM válido.", error);
  }

  try {
    const key = material.privateKeyPassphrase
      ? forge.pki.decryptRsaPrivateKey(material.privateKeyPem, material.privateKeyPassphrase)
      : forge.pki.privateKeyFromPem(material.privateKeyPem);
    if (!key) throw new Error("clave nula");
    privateKey = key as forge.pki.rsa.PrivateKey;
  } catch (error) {
    throw new PassSigningError(
      "No se pudo leer la clave privada. ¿Falta la passphrase, o sobra?",
      error,
    );
  }

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifest.toString("binary"));
  p7.addCertificate(certificate);
  p7.addCertificate(wwdr);
  p7.addSigner({
    key: privateKey,
    certificate,
    digestAlgorithm: oid("sha256"),
    authenticatedAttributes: [
      { type: oid("contentType"), value: oid("data") },
      { type: oid("messageDigest") },
      { type: oid("signingTime"), value: (signedAt ?? new Date()).toISOString() },
    ],
  });

  p7.sign({ detached: true });

  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
}
