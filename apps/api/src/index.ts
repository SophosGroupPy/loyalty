/**
 * Punto de entrada del servicio.
 *
 * En Railway corre con `DATABASE_URL` apuntando al Postgres del proyecto. Sin
 * esa variable levanta PGlite en memoria, que sirve para probar en local pero
 * pierde todo al reiniciar.
 */

import { createDb, runMigrations } from "@sophos/db";

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

const app = createServer({
  db,
  signingKey: requireSigningKey(),
  logger: true,
  ...(googleWallet ? { googleWallet } : {}),
});

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });

console.log(`[loyalty] API escuchando en :${port}`);
