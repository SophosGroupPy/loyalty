/**
 * Diagnóstico de credenciales contra la API real de Google.
 *
 *   pnpm check:google
 *
 * Distingue tres fallas que se confunden entre sí porque los errores de Google
 * no las diferencian:
 *
 *  1. La clave privada no sirve → falla el intercambio del token.
 *  2. La clave sirve pero la service account no fue invitada en Wallet Console
 *     → 403 al tocar cualquier recurso del issuer. Es el error más común y el
 *     mensaje de Google no menciona que falte una invitación.
 *  3. Todo bien pero la clase todavía no existe → 404, que es esperable antes
 *     de emitir la primera tarjeta.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTokenProvider } from "@sophos/passes";

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
    /* sin .env.local seguimos con lo que haya en el entorno */
  }
}

const ok = (t: string) => console.log(`  \x1b[32m✓\x1b[0m ${t}`);
const bad = (t: string) => console.log(`  \x1b[31m✗\x1b[0m ${t}`);
const warn = (t: string) => console.log(`  \x1b[33m⚠\x1b[0m ${t}`);

async function main(): Promise<void> {
  loadEnv();

  const config = googleWalletConfigFromEnv();
  if (!config) {
    bad("Faltan credenciales en .env.local. Ver docs/google-wallet-verificacion.md");
    process.exit(1);
  }

  console.log(`\n\x1b[1mIssuer ${config.issuerId}\x1b[0m`);
  console.log(`  ${config.serviceAccountEmail}\n`);

  // 1. ¿Google acepta la clave privada?
  let token: string;
  try {
    token = await createTokenProvider(config)();
    ok("Google aceptó la clave privada y emitió un access token");
  } catch (error) {
    bad(`Google rechazó las credenciales: ${(error as Error).message}`);
    console.log("\n  Revisá que GOOGLE_WALLET_SA_PRIVATE_KEY sea el campo");
    console.log("  `private_key` completo del JSON, incluidas las líneas BEGIN/END.\n");
    process.exit(1);
  }

  // 2. ¿La service account está invitada en Wallet Console?
  const response = await fetch(
    `https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass?issuerId=${config.issuerId}`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    const raw = await response.text();
    bad(`La API respondió ${response.status}`);

    // Se imprime el mensaje de Google textual antes de cualquier interpretación:
    // un 403 puede ser "API deshabilitada en el proyecto" o "sin acceso al
    // issuer", y son arreglos completamente distintos. Adivinar cuál es manda a
    // buscar el problema al lugar equivocado.
    console.log("\n  \x1b[2mRespuesta de Google:\x1b[0m");
    try {
      const parsed = JSON.parse(raw) as {
        error?: { message?: string; status?: string; details?: unknown[] };
      };
      console.log(`    ${parsed.error?.status ?? ""} ${parsed.error?.message ?? raw}`);
      for (const detail of parsed.error?.details ?? []) {
        console.log(`    ${JSON.stringify(detail)}`);
      }
    } catch {
      console.log(`    ${raw.slice(0, 800)}`);
    }

    if (response.status === 403) {
      console.log("\n  \x1b[1mLas dos causas posibles de un 403:\x1b[0m");
      console.log("\n  a) La Wallet API no está habilitada en el proyecto de GCP.");
      console.log("     El mensaje de arriba lo dice explícitamente si es el caso.");
      console.log("     Se arregla acá:");
      console.log(
        "     https://console.cloud.google.com/apis/library/walletobjects.googleapis.com?project=" +
          (process.env.GOOGLE_WALLET_SA_EMAIL?.split("@")[1]?.split(".")[0] ?? ""),
      );
      console.log("\n  b) La service account no está invitada en Wallet Console.");
      console.log("     Wallet Console → Users → Invite a user, rol Developer:");
      console.log(`       ${config.serviceAccountEmail}`);
    }

    console.log("");
    process.exit(1);
  }

  ok("La service account tiene acceso al issuer");

  const body = (await response.json()) as {
    resources?: { id: string; issuerName?: string; reviewStatus?: string }[];
  };
  const classes = body.resources ?? [];

  if (classes.length === 0) {
    warn("El issuer todavía no tiene clases. Corré `pnpm demo` para crear la primera.");
  } else {
    console.log(`\n\x1b[1mClases registradas (${classes.length})\x1b[0m`);
    for (const c of classes) {
      const brand = c.issuerName ?? "(sin issuerName)";
      console.log(`  ${c.id}`);
      console.log(`    marca visible: ${brand}   estado: ${c.reviewStatus ?? "?"}`);
      if (brand.toLowerCase().includes("sophos")) {
        warn("    ⚠ Esta clase muestra a Sophos como marca. Debería ser el comercio.");
      }
    }
  }

  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
