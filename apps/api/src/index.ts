/**
 * Punto de entrada del servicio.
 *
 * En Railway corre con `DATABASE_URL` apuntando al Postgres del proyecto. Sin
 * esa variable levanta PGlite en memoria, que sirve para probar en local pero
 * pierde todo al reiniciar.
 */

/**
 * Carga `.env.local` en desarrollo.
 *
 * Sin esto ninguna credencial llegaba al proceso: el archivo existía, tenía las
 * claves de Google adentro, y el servidor arrancaba diciendo que Google no
 * estaba configurado. En producción las variables las pone el entorno y este
 * archivo no existe, así que se ignora en silencio.
 */
if (process.env.NODE_ENV !== "production") {
  try {
    process.loadEnvFile(new URL("../../../.env.local", import.meta.url).pathname);
  } catch {
    // No existe, y está bien: se corre con lo que haya en el entorno.
  }
}

import { createDb, runMigrations } from "@sophos/db";

import { appleWalletConfigFromEnv } from "./apple-pass.js";
import { googleWalletConfigFromEnv } from "./passes.js";
import { createServer } from "./server.js";

function requireSigningKey(): Uint8Array {
  const secret = process.env.JWT_SIGNING_KEY;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Falta JWT_SIGNING_KEY. Sin una clave estable, cada reinicio invalida " +
          "los tokens de todos los productos integrados.",
      );
    }
    console.warn(
      "[loyalty] JWT_SIGNING_KEY no está definida: usando una clave efímera de desarrollo.",
    );
    return new TextEncoder().encode("dev-only-insecure-signing-key-32bytes!");
  }

  return new TextEncoder().encode(secret);
}

/**
 * En producción la base tiene que ser un Postgres real.
 *
 * Sin esta guarda, olvidarse de adjuntar la base en Railway no rompe nada
 * visible: el servicio arranca, acepta altas, emite tarjetas y acumula
 * puntos — y pierde todo en el primer reinicio. Es la peor forma de fallar,
 * porque parece que funciona.
 */
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  throw new Error(
    "Falta DATABASE_URL en producción. Sin ella el servicio arrancaría con una " +
      "base en memoria: aceptaría altas y perdería todo al reiniciar.",
  );
}

const db = await createDb();
await runMigrations(db);

// Sin `DATABASE_URL` la base es PGlite en memoria y arranca vacía, así que la
// landing de alta no tendría ningún comercio que mostrar. La condición está acá
// y no dentro de `seedDev` para que sea imposible sembrar un Postgres real.
if (!process.env.DATABASE_URL) {
  const { seedDev, DEV_MERCHANT_SLUG } = await import("./dev-seed.js");
  await seedDev(db);
  console.log(`[loyalty] base en memoria sembrada — comercio /${DEV_MERCHANT_SLUG}`);
}

const googleWallet = googleWalletConfigFromEnv();
if (!googleWallet) {
  console.warn(
    "[loyalty] Google Wallet sin configurar: /v1/passes responde 503. " +
      "Falta GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_SA_EMAIL o GOOGLE_WALLET_SA_PRIVATE_KEY.",
  );
}

const appleWallet = appleWalletConfigFromEnv();
if (!appleWallet) {
  console.warn(
    "[loyalty] Apple Wallet sin configurar: se pueden registrar dispositivos " +
      "pero no emitir pases. Falta APPLE_TEAM_ID o APPLE_WEB_SERVICE_URL.",
  );
} else if (!appleWallet.encryptionKey || !appleWallet.wwdrCertificatePem) {
  // El registro de dispositivos funciona sin esto; la emisión no. Se avisa
  // distinto del caso anterior porque el síntoma es otro: el pase se pide y
  // responde 503, en vez de no existir la ruta.
  console.warn(
    "[loyalty] Apple Wallet a medias: /apple/v1/passes responde 503. " +
      "Falta APPLE_PASS_ENCRYPTION_KEY o APPLE_WWDR_PEM.",
  );
}

if (!process.env.ADMIN_API_KEY) {
  console.warn("[loyalty] Back-office deshabilitado: falta ADMIN_API_KEY.");
}

const app = createServer({
  db,
  signingKey: requireSigningKey(),
  logger: true,
  ...(googleWallet ? { googleWallet } : {}),
  ...(appleWallet ? { appleWallet } : {}),
});

const port = Number(process.env.PORT ?? 4001);
await app.listen({ port, host: "0.0.0.0" });

console.log(`[loyalty] API escuchando en :${port}`);
