/**
 * Siembra de desarrollo.
 *
 * Solo corre cuando la API levanta con PGlite en memoria, es decir cuando no hay
 * `DATABASE_URL`. Sin esto, `pnpm dev` arranca con una base vacía y la landing
 * de alta no tiene ningún comercio que mostrar.
 *
 * **Nunca se ejecuta contra un Postgres real**: la condición vive en el punto de
 * entrada, no acá.
 */

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";

import { hashSecret } from "./auth.js";

export const DEV_CLIENT_ID = "dev-elmenu";
export const DEV_CLIENT_SECRET = "dev-secret";
export const DEV_MERCHANT_SLUG = "don-julio";

export async function seedDev(db: Db): Promise<void> {
  const product = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', ${DEV_CLIENT_ID}, ${await hashSecret(DEV_CLIENT_SECRET)})
        RETURNING id`,
  );
  const productId = product[0]?.id;
  if (!productId) throw new Error("no se pudo sembrar el producto de desarrollo");

  const merchant = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name, design)
        VALUES (${productId}, 'dev-1', ${DEV_MERCHANT_SLUG}, 'Don Julio SA', 'Don Julio',
                ${JSON.stringify({
                  programName: "Puntos Don Julio",
                  logoUrl: "https://www.sophosgroup.com.py/brand/web/logo-symbol.png",
                  backgroundColor: "#DC2626",
                  balanceLabel: "Puntos",
                  newsLabel: "Novedades",
                })}::jsonb)
        RETURNING id`,
  );
  const merchantId = merchant[0]?.id;
  if (!merchantId) throw new Error("no se pudo sembrar el comercio de desarrollo");

  await rows(
    db.drizzle,
    sql`INSERT INTO program (merchant_id, kind, config, status)
        VALUES (${merchantId}, 'points', ${JSON.stringify({
          kind: "points",
          earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }],
          tiers: [
            { name: "Plata", min: 50 },
            { name: "Oro", min: 200 },
          ],
        })}::jsonb, 'active')`,
  );

  await rows(
    db.drizzle,
    sql`INSERT INTO reward (program_id, merchant_id, name, cost, status)
        SELECT id, ${merchantId}, 'Café gratis', 10, 'active' FROM program
        WHERE merchant_id = ${merchantId}`,
  );

  await rows(
    db.drizzle,
    sql`INSERT INTO merchant_location (merchant_id, label, latitude, longitude, relevant_text)
        VALUES (${merchantId}, 'Villa Morra', -25.2965, -57.5759, 'Estás cerca de Don Julio')`,
  );
}
