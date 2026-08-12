/**
 * Punto de entrada del servicio.
 *
 * En Railway corre con `DATABASE_URL` apuntando al Postgres del proyecto. Sin
 * esa variable levanta PGlite en memoria, que sirve para probar en local pero
 * pierde todo al reiniciar.
 */

import { createDb, runMigrations } from "@sophos/db";

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

const app = createServer({ db, signingKey: requireSigningKey(), logger: true });

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });

console.log(`[loyalty] API escuchando en :${port}`);
