/**
 * Cifrado de claves privadas en reposo.
 *
 * Lo único que se cifra son las claves privadas de los certificados de Pass
 * Type ID. El certificado en sí es público —viaja dentro de cada `.pkpass`— y
 * cifrarlo solo agregaría ruido.
 *
 * AES-256-GCM y no AES-CBC: GCM autentica además de cifrar. Sin autenticación,
 * un texto cifrado alterado se descifra como basura y terminaríamos intentando
 * firmar con una clave corrupta, con un error incomprensible tres capas más
 * arriba. Con GCM, el descifrado falla de entrada y dice por qué.
 *
 * **La clave de cifrado nunca va a la base.** Vive en el gestor de secretos. Si
 * estuvieran las dos en el mismo lugar, cifrar sería teatro.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
/** GCM usa 96 bits: es el tamaño para el que está definido, no una elección. */
const NONCE_BYTES = 12;

export interface SealedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/**
 * Normaliza la clave de cifrado que viene por configuración.
 *
 * Se acepta hex o base64 de 32 bytes, y **no** una passphrase suelta: derivar
 * una clave de un texto corto sin KDF daría una sensación de seguridad que no
 * existe. Que falle el arranque es preferible a cifrar con 16 bytes de entropía.
 */
export function encryptionKeyFrom(raw: string | undefined): Buffer | null {
  if (!raw) return null;

  const value = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new SecretError(
      `La clave de cifrado tiene que ser de 32 bytes en hex o base64; llegaron ${key.length}.`,
    );
  }
  return key;
}

export function seal(plaintext: string, key: Buffer): SealedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

export function open(sealed: SealedSecret, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, sealed.nonce);
  decipher.setAuthTag(sealed.tag);

  try {
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // `final()` tira acá cuando el tag no valida: o la clave es otra, o alguien
    // tocó el texto cifrado. No se distingue a propósito — decir cuál de las dos
    // es le daría información a quien esté probando.
    throw new SecretError(
      "No se pudo descifrar la clave privada: la clave de cifrado no corresponde, o el dato fue alterado.",
    );
  }
}
