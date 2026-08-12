/**
 * Autenticación de los productos integradores y resolución de tenant.
 *
 * Los productos hablan con esta API backend a backend, con OAuth2
 * client_credentials. Nunca hay un token de loyalty en el cliente: quien tenga
 * uno puede leer la base de clientes de un comercio.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";

import { rows, type Db } from "@sophos/db";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 32;

/** Deriva el hash de un client_secret para guardarlo. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(secret, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/** Verifica un client_secret contra su hash, en tiempo constante. */
export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, "base64");
  const derived = await scryptAsync(secret, Buffer.from(saltB64, "base64"), expected.length);

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface TokenClaims {
  productId: string;
  productSlug: string;
}

const ISSUER = "sophos-loyalty";

/** Emite un access token para un producto. */
export async function issueToken(
  signingKey: Uint8Array,
  claims: TokenClaims,
  ttlSeconds = 3600,
): Promise<{ accessToken: string; expiresIn: number }> {
  const accessToken = await new SignJWT({ slug: claims.productSlug })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.productId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(signingKey);

  return { accessToken, expiresIn: ttlSeconds };
}

/** Valida un access token. Devuelve `null` si es inválido o venció. */
export async function verifyToken(
  signingKey: Uint8Array,
  token: string,
): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey, { issuer: ISSUER });
    if (!payload.sub || typeof payload.slug !== "string") return null;
    return { productId: payload.sub, productSlug: payload.slug };
  } catch {
    return null;
  }
}

/** Valida credenciales de cliente y devuelve el producto. */
export async function authenticateProduct(
  db: Db,
  clientId: string,
  clientSecret: string,
): Promise<TokenClaims | null> {
  const found = await rows<{ id: string; slug: string; client_secret_hash: string }>(
    db.drizzle,
    sql`SELECT id, slug, client_secret_hash FROM product WHERE client_id = ${clientId}`,
  );

  const product = found[0];
  if (!product) {
    // Se corre igual una derivación descartable para que un client_id inexistente
    // tarde lo mismo que uno con secreto incorrecto y no se pueda enumerar.
    await hashSecret(clientSecret);
    return null;
  }

  if (!(await verifySecret(clientSecret, product.client_secret_hash))) return null;
  return { productId: product.id, productSlug: product.slug };
}

export interface ResolvedMerchant {
  id: string;
  externalId: string;
  slug: string;
  displayName: string;
  timezone: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resuelve un comercio dentro del producto que hace el pedido.
 *
 * **`productId` es obligatorio y siempre entra en el WHERE.** Es el único punto
 * donde se traduce una referencia externa a un `merchant_id` interno, así que es
 * también el punto donde se corta el acceso cruzado: un token de ElMenu no
 * resuelve un comercio de Noctu ni con el UUID exacto en la mano.
 */
export async function resolveMerchant(
  db: Db,
  productId: string,
  ref: string,
): Promise<ResolvedMerchant | null> {
  const found = await rows<{
    id: string;
    external_id: string;
    slug: string;
    display_name: string;
    timezone: string;
  }>(
    db.drizzle,
    UUID_RE.test(ref)
      ? sql`SELECT id, external_id, slug, display_name, timezone FROM merchant
            WHERE product_id = ${productId} AND id = ${ref}`
      : sql`SELECT id, external_id, slug, display_name, timezone FROM merchant
            WHERE product_id = ${productId} AND external_id = ${ref}`,
  );

  const merchant = found[0];
  if (!merchant) return null;

  return {
    id: merchant.id,
    externalId: merchant.external_id,
    slug: merchant.slug,
    displayName: merchant.display_name,
    timezone: merchant.timezone,
  };
}
