/**
 * Renombra la marca visible de una clase.
 *
 *   pnpm rename:class <slug> "<nuevo issuerName>"
 *
 * Se hace por API y no por la consola a propósito: el formulario de la consola
 * reenvía el objeto completo, incluido un `Status` que puede venir desfasado del
 * estado real, y guardar desde ahí puede degradar la clase sin querer. Un PATCH
 * con un solo campo toca exactamente ese campo.
 *
 * Las clases de Google Wallet **no se pueden borrar ni archivar** — la API no
 * expone `delete`. Renombrar es lo más parecido a retirar una clase de prueba.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { classIdFor, createTokenProvider } from "@sophos/passes";

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
    /* seguimos con el entorno */
  }
}

async function main(): Promise<void> {
  loadEnv();

  const config = googleWalletConfigFromEnv();
  if (!config) throw new Error("Faltan credenciales de Google en .env.local");

  const slug = process.argv[2];
  const issuerName = process.argv[3];
  if (!slug || !issuerName) {
    console.error('Uso: pnpm rename:class <slug> "<nuevo issuerName>"');
    process.exit(1);
  }

  const classId = classIdFor(config.issuerId, slug);
  const token = await createTokenProvider(config)();
  const url = `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${encodeURIComponent(classId)}`;

  const before = await (
    await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  ).json();

  // Hay que reenviar `reviewStatus: UNDER_REVIEW` sí o sí. Google rechaza
  // cualquier edición que llegue con `APPROVED`, porque ese valor lo asigna él y
  // no se puede reenviar:
  //
  //   Invalid review status "APPROVED". Use "UNDER_REVIEW" instead.
  //
  // No degrada nada en la práctica: Google vuelve a aprobar automáticamente.
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ issuerName, reviewStatus: "UNDER_REVIEW" }),
  });

  if (!response.ok) {
    console.error(`\n  ✗ HTTP ${response.status}: ${await response.text()}\n`);
    process.exit(1);
  }

  const after = (await response.json()) as { issuerName: string; reviewStatus: string };

  console.log(`\n  \x1b[32m✓\x1b[0m ${classId}`);
  console.log(`    issuerName:   "${before.issuerName}" → "${after.issuerName}"`);
  console.log(`    reviewStatus: ${before.reviewStatus} → ${after.reviewStatus}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
