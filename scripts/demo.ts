/**
 * Demo end-to-end: de cero a una tarjeta guardable en un teléfono.
 *
 * Siembra un restaurante de prueba con su programa, beneficios y diseño, da de
 * alta una clienta, le acumula puntos y emite el pase. Imprime el link de
 * "Add to Google Wallet" listo para abrir.
 *
 *   pnpm demo
 *
 * Sin credenciales de Google corre igual y muestra todo el flujo salvo la
 * emisión — sirve para ver el motor funcionando antes de que exista el Issuer.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";

import { createTestDb, rows } from "@sophos/db";

import { hashSecret } from "../apps/api/src/auth.js";
import { googleWalletConfigFromEnv } from "../apps/api/src/passes.js";
import { createServer } from "../apps/api/src/server.js";

/** Lee .env.local sin dependencias. */
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
    // Sin .env.local se sigue igual: la demo funciona sin credenciales.
  }
}

const CLIENT_ID = "demo-elmenu";
const CLIENT_SECRET = "demo-secret";

/** Logo público de prueba. Google lo descarga, así que no puede ser localhost. */
const LOGO = "https://www.sophosgroup.com.py/brand/web/logo-symbol.png";

function title(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

function ok(text: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${text}`);
}

async function main(): Promise<void> {
  loadEnv();

  const googleWallet = googleWalletConfigFromEnv();
  const db = await createTestDb();

  await rows(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', ${CLIENT_ID}, ${await hashSecret(CLIENT_SECRET)})`,
  );

  const app = createServer({
    db,
    signingKey: new TextEncoder().encode("demo-signing-key-solo-para-esta-corrida"),
    ...(googleWallet ? { googleWallet } : {}),
  });
  await app.ready();

  const auth = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    },
  });
  const token = auth.json().access_token;

  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload: payload as object } : {}),
    });

  // -------------------------------------------------------------------------
  title("1. Alta del comercio");

  await call("POST", "/v1/merchants", {
    externalId: "demo-1",
    slug: "don-julio",
    legalName: "Don Julio SA",
    displayName: "Don Julio",
  });
  ok("Comercio «Don Julio» creado");

  await call("PUT", "/v1/programs", {
    merchant: "demo-1",
    kind: "points",
    config: {
      earn: [
        { on: "order.paid", rate: { per: 10_000, points: 1 } },
        { on: "order.paid", multiplier: 2, when: { weekday: ["thu"] } },
      ],
      tiers: [
        { name: "Plata", min: 50 },
        { name: "Oro", min: 200 },
      ],
      caps: { perDay: 100 },
      notifications: { quietHours: { from: 23, to: 9 }, coalesceMinutes: 15 },
    },
  });
  ok("Programa de puntos: 1 cada 10.000 Gs, x2 los jueves, tope 100/día");

  await call("PUT", "/v1/design", {
    merchant: "demo-1",
    programName: "Puntos Don Julio",
    logoUrl: LOGO,
    backgroundColor: "#DC2626",
    balanceLabel: "Puntos",
    newsLabel: "Novedades",
  });
  ok("Diseño de tarjeta configurado");

  await call("POST", "/v1/locations", {
    merchant: "demo-1",
    label: "Villa Morra",
    latitude: -25.2965,
    longitude: -57.5759,
    relevantText: "Estás cerca de Don Julio",
  });
  ok("Geocerca en Villa Morra");

  const cafe = await call("POST", "/v1/rewards", {
    merchant: "demo-1",
    name: "Café gratis",
    cost: 10,
  });
  await call("POST", "/v1/rewards", {
    merchant: "demo-1",
    name: "Postre de la casa",
    cost: 40,
  });
  ok("Beneficios: café gratis (10) y postre (40)");

  // -------------------------------------------------------------------------
  title("2. Alta de la clienta");

  const card = await call("POST", "/v1/memberships", {
    merchant: "demo-1",
    phone: "0993427654",
    displayName: "Ana",
    phoneVerified: true,
  });
  const { membershipId, serialNumber } = card.json();
  ok(`Tarjeta emitida — serial ${serialNumber}`);

  // -------------------------------------------------------------------------
  title("3. Consumo");

  const consumo = await call("POST", "/v1/events", {
    merchant: "demo-1",
    idempotencyKey: "demo-order-1",
    type: "order.paid",
    amount: 185_000,
    membership: { id: membershipId },
  });
  const result = consumo.json();
  ok(`Consumo de 185.000 Gs → ${result.amount} puntos (saldo ${result.balance})`);

  const repetido = await call("POST", "/v1/events", {
    merchant: "demo-1",
    idempotencyKey: "demo-order-1",
    type: "order.paid",
    amount: 185_000,
    membership: { id: membershipId },
  });
  ok(
    `Mismo pedido reenviado → duplicate=${repetido.json().duplicate}, ` +
      `saldo sigue en ${repetido.json().balance}`,
  );

  // -------------------------------------------------------------------------
  title("4. Lo que ve el cajero");

  const pos = await call("GET", "/v1/memberships/lookup?merchant=demo-1&phone=0993427654");
  const view = pos.json();
  // `unit` es un valor de máquina; la traducción para mostrar es del consumidor
  // de la API, que en producción va a ser el POS de ElMenu o de Noctu.
  const unidad = view.unit === "stamps" ? "sellos" : "puntos";
  console.log(`  Cliente: ${view.displayName}`);
  console.log(`  Saldo:   ${view.balance} ${unidad}${view.tier ? ` — nivel ${view.tier}` : ""}`);
  console.log(
    `  Puede canjear: ${
      view.availableRewards.map((r: { name: string }) => r.name).join(", ") || "nada todavía"
    }`,
  );

  // -------------------------------------------------------------------------
  title("5. Canje");

  const canje = await call("POST", "/v1/redemptions", {
    merchant: "demo-1",
    rewardId: cafe.json().id,
    membership: { id: membershipId },
    redeemedBy: "staff:demo",
  });
  ok(`Café gratis canjeado — saldo ${canje.json().balance}`);

  // -------------------------------------------------------------------------
  title("6. Tarjeta en la wallet");

  if (!googleWallet) {
    console.log("  \x1b[33m⚠\x1b[0m  Google Wallet sin configurar: no se emite el pase.");
    console.log("     Completá .env.local con la service account y volvé a correr.");
    console.log("     Ver docs/google-wallet-verificacion.md");
  } else {
    const pass = await call("POST", "/v1/passes", {
      merchant: "demo-1",
      membership: { id: membershipId },
    });

    if (pass.statusCode !== 201) {
      console.log(`  \x1b[31m✗\x1b[0m  Falló la emisión (HTTP ${pass.statusCode}):`);
      console.log(`     ${pass.body}`);
    } else {
      const { saveUrl, classRegistered, classError } = pass.json();
      ok(`Issuer ${googleWallet.issuerId}`);

      if (classRegistered) {
        ok("Clase registrada en Google — la tarjeta va a recibir actualizaciones");
      } else {
        console.log(`  \x1b[31m✗\x1b[0m  No se pudo registrar la clase en Google:`);
        console.log(`     ${classError}`);
        console.log("");
        console.log("     El link de abajo igual guarda la tarjeta, porque la clase");
        console.log("     viaja adentro. Pero \x1b[1mel saldo va a quedar congelado\x1b[0m:");
        console.log("     sin la clase registrada, las actualizaciones no llegan.");
        console.log("");
        console.log("     Corré \x1b[36mpnpm check:google\x1b[0m para diagnosticar.");
      }

      console.log("\n  Abrí este link en Chrome con la cuenta de prueba,");
      console.log("  o en el emulador de Android:\n");
      console.log(`\x1b[36m${saveUrl}\x1b[0m`);
      console.log("\n  Verificá que la tarjeta diga «Don Julio» y no Sophos.");
    }
  }

  await app.close();
  await db.close();
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
