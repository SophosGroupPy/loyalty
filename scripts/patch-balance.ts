/**
 * Empuja un saldo a un pase ya emitido, para comprobar que la actualización
 * llega sin reinstalar la tarjeta.
 *
 *   pnpm patch:balance <serial> <saldo>
 *
 * Es la prueba del criterio de verificación más importante de la capa de wallet:
 * si esto no funciona, cada acumulación exigiría reemitir el pase y el producto
 * no sirve.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createGoogleWalletClient, objectIdFor } from "@sophos/passes";

import { googleWalletConfigFromEnv } from "../apps/api/src/passes.js";

function loadEnv(): void {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match?.[1]) continue;
      let value = match[2] ?? "";
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[match[1]]) process.env[match[1]] = value;
    }
  } catch {
    /* seguimos con lo que haya en el entorno */
  }
}

async function main(): Promise<void> {
  loadEnv();

  const config = googleWalletConfigFromEnv();
  if (!config) throw new Error("Faltan credenciales de Google en .env.local");

  const serial = process.argv[2];
  const balance = Number(process.argv[3]);

  if (!serial || Number.isNaN(balance)) {
    console.error("Uso: pnpm patch:balance <serial> <saldo>");
    process.exit(1);
  }

  const objectId = objectIdFor(config.issuerId, serial);
  const client = createGoogleWalletClient(config);

  await client.syncBalance({
    objectId,
    balance,
    balanceLabel: "Puntos",
    // Sin notificar: acá solo se verifica que el dato viaje. El aviso al cliente
    // lo decide el despachador, que es el único que ve el cupo diario.
    notify: false,
  });

  console.log(`\n  \x1b[32m✓\x1b[0m ${objectId} → ${balance} puntos`);
  console.log("    Recargá la tarjeta en la wallet: el saldo tiene que cambiar");
  console.log("    sin reinstalar el pase.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
