/**
 * Emisión y sincronización de tarjetas en wallet.
 *
 * **La regla que ordena todo este módulo: el ledger es la verdad y el pase es
 * una vista de esa verdad.** Una caída de Google no puede hacer fallar una
 * acumulación — el cliente ya consumió y sus puntos le corresponden. Por eso la
 * sincronización corre fuera de la transacción del asiento, no propaga
 * excepciones, y deja registrado el desfasaje para que un reconciliador lo
 * retome después.
 */

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";
import {
  buildLoyaltyClass,
  buildLoyaltyObject,
  buildSaveLink,
  createGoogleWalletClient,
  objectIdFor,
  type CardDesign,
  type GoogleWalletClient,
  type GoogleWalletConfig,
  type PassLocation,
} from "@sophos/passes";

/** Diseño por defecto, para que un comercio recién dado de alta ya pueda emitir. */
export const DEFAULT_DESIGN: CardDesign = {
  programName: "Programa de fidelidad",
  logoUrl: "",
  backgroundColor: "#1F2937",
  balanceLabel: "Puntos",
  newsLabel: "Novedades",
};

export interface PassService {
  /** `false` cuando no hay credenciales de Google configuradas. */
  readonly enabled: boolean;
  issueGooglePass(membershipId: string, merchantId: string): Promise<string>;
  syncGooglePass(membershipId: string): Promise<SyncOutcome>;
  pendingSync(limit?: number): Promise<{ membershipId: string; drift: number }[]>;
}

export type SyncOutcome =
  | { status: "synced"; balance: number }
  | { status: "skipped"; reason: "no_pass" | "disabled" | "already_current" }
  | { status: "failed"; error: string };

interface CardRow {
  membership_id: string;
  merchant_id: string;
  merchant_slug: string;
  display_name: string;
  legal_name: string;
  design: CardDesign | null;
  serial_number: string;
  holder_name: string | null;
  balance: number;
  tier: string | null;
  program_kind: "points" | "stamps";
}

/**
 * Servicio de pases.
 *
 * Sin `config` queda deshabilitado y devuelve resultados explícitos en vez de
 * romper: mientras no exista el Issuer de Google, el resto del sistema tiene que
 * seguir funcionando entero.
 */
export function createPassService(
  db: Db,
  config?: GoogleWalletConfig,
  fetchImpl?: typeof fetch,
): PassService {
  const client: GoogleWalletClient | null = config
    ? createGoogleWalletClient(config, fetchImpl)
    : null;

  async function loadCard(membershipId: string): Promise<CardRow | null> {
    const found = await rows<CardRow>(
      db.drizzle,
      sql`SELECT m.id AS membership_id, m.merchant_id, m.serial_number, m.balance, m.tier,
                 m.display_name AS holder_name,
                 mer.slug AS merchant_slug, mer.display_name, mer.legal_name, mer.design,
                 p.kind AS program_kind
          FROM membership m
          JOIN merchant mer ON mer.id = m.merchant_id
          JOIN program p ON p.id = m.program_id
          WHERE m.id = ${membershipId}`,
    );
    return found[0] ?? null;
  }

  async function loadLocations(merchantId: string): Promise<PassLocation[]> {
    const found = await rows<{ latitude: number; longitude: number; label: string }>(
      db.drizzle,
      sql`SELECT latitude, longitude, label FROM merchant_location
          WHERE merchant_id = ${merchantId}
          ORDER BY created_at
          LIMIT 10`,
    );
    return found;
  }

  function designOf(card: CardRow): CardDesign {
    const stored = card.design ?? ({} as Partial<CardDesign>);

    return {
      ...DEFAULT_DESIGN,
      ...stored,
      // Los fallbacks van después del spread: si el comercio guardó un diseño
      // parcial, un campo vacío no puede pisar el valor calculado.
      programName: stored.programName || card.display_name,
      balanceLabel:
        stored.balanceLabel || (card.program_kind === "stamps" ? "Sellos" : "Puntos"),
    };
  }

  return {
    enabled: Boolean(config),

    /**
     * Emite la tarjeta y devuelve el link de "Add to Google Wallet".
     *
     * La clase viaja dentro del propio link, así que el primer guardado no
     * depende de que la clase ya exista en Google.
     */
    async issueGooglePass(membershipId, merchantId) {
      if (!config) {
        throw new Error(
          "Google Wallet no está configurado: falta GOOGLE_WALLET_ISSUER_ID y la service account.",
        );
      }

      const card = await loadCard(membershipId);
      if (!card || card.merchant_id !== merchantId) {
        throw new Error("La tarjeta no existe en este comercio.");
      }

      const design = designOf(card);
      const loyaltyClass = buildLoyaltyClass({
        issuerId: config.issuerId,
        merchant: {
          slug: card.merchant_slug,
          displayName: card.display_name,
          legalName: card.legal_name,
        },
        design,
        locations: await loadLocations(merchantId),
      });

      const object = buildLoyaltyObject({
        issuerId: config.issuerId,
        merchantSlug: card.merchant_slug,
        serialNumber: card.serial_number,
        accountName: card.holder_name,
        balance: card.balance,
        balanceLabel: design.balanceLabel,
        tier: card.tier,
      });

      // La clase se registra igual por API: el link la lleva para el primer
      // guardado, pero las actualizaciones posteriores necesitan que exista.
      if (client) {
        try {
          await client.upsertClass(loyaltyClass);
        } catch (error) {
          // Que falle el registro de la clase no debe impedir entregar el link:
          // el pase igual se guarda porque viaja completo adentro.
          await recordError(db, membershipId, error);
        }
      }

      const link = await buildSaveLink(config, { object, loyaltyClass });

      await rows(
        db.drizzle,
        sql`INSERT INTO pass_instance
              (membership_id, merchant_id, platform, external_id, state,
               last_synced_balance, last_synced_at)
            VALUES (${membershipId}, ${merchantId}, 'google',
                    ${objectIdFor(config.issuerId, card.serial_number)}, 'active',
                    ${card.balance}, now())
            ON CONFLICT (membership_id, platform) DO UPDATE
              SET state = 'active',
                  last_synced_balance = EXCLUDED.last_synced_balance,
                  last_synced_at = now(),
                  last_error = NULL`,
      );

      return link;
    },

    /**
     * Empuja el saldo actual al pase.
     *
     * Nunca lanza: un fallo queda registrado en `pass_instance.last_error` y el
     * desfasaje se detecta comparando `last_synced_balance` con el saldo real.
     */
    async syncGooglePass(membershipId) {
      if (!client || !config) return { status: "skipped", reason: "disabled" };

      const pass = await rows<{ external_id: string; last_synced_balance: number | null }>(
        db.drizzle,
        sql`SELECT external_id, last_synced_balance FROM pass_instance
            WHERE membership_id = ${membershipId} AND platform = 'google' AND state = 'active'`,
      );
      const instance = pass[0];
      if (!instance) return { status: "skipped", reason: "no_pass" };

      const card = await loadCard(membershipId);
      if (!card) return { status: "skipped", reason: "no_pass" };

      if (instance.last_synced_balance === card.balance) {
        return { status: "skipped", reason: "already_current" };
      }

      try {
        await client.syncBalance({
          objectId: instance.external_id,
          balance: card.balance,
          balanceLabel: designOf(card).balanceLabel,
          // Solo el cambio de saldo dispara push en Google. El cupo de 3 por
          // tarjeta cada 24 h lo administra el despachador de notificaciones,
          // no este módulo.
          notify: true,
        });

        await rows(
          db.drizzle,
          sql`UPDATE pass_instance
              SET last_synced_balance = ${card.balance}, last_synced_at = now(), last_error = NULL
              WHERE membership_id = ${membershipId} AND platform = 'google'`,
        );

        return { status: "synced", balance: card.balance };
      } catch (error) {
        await recordError(db, membershipId, error);
        return { status: "failed", error: messageOf(error) };
      }
    },

    /**
     * Tarjetas cuyo pase quedó atrás del saldo real.
     *
     * Es la cola de reconciliación: si Google estuvo caído mientras se acumulaba,
     * acá aparecen los pases a reintentar.
     */
    async pendingSync(limit = 100) {
      const found = await rows<{ membership_id: string; drift: number }>(
        db.drizzle,
        sql`SELECT pi.membership_id,
                   (m.balance - COALESCE(pi.last_synced_balance, 0)) AS drift
            FROM pass_instance pi
            JOIN membership m ON m.id = pi.membership_id
            WHERE pi.state = 'active'
              AND pi.platform = 'google'
              AND m.balance IS DISTINCT FROM pi.last_synced_balance
            ORDER BY pi.last_synced_at NULLS FIRST
            LIMIT ${limit}`,
      );

      return found.map((r) => ({ membershipId: r.membership_id, drift: r.drift }));
    },
  };
}

async function recordError(db: Db, membershipId: string, error: unknown): Promise<void> {
  await rows(
    db.drizzle,
    sql`UPDATE pass_instance SET last_error = ${messageOf(error)}
        WHERE membership_id = ${membershipId} AND platform = 'google'`,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lee la configuración de Google del entorno. Devuelve `undefined` si falta algo. */
export function googleWalletConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GoogleWalletConfig | undefined {
  const issuerId = env.GOOGLE_WALLET_ISSUER_ID;
  const serviceAccountEmail = env.GOOGLE_WALLET_SA_EMAIL;
  const privateKeyPem = env.GOOGLE_WALLET_SA_PRIVATE_KEY;

  if (!issuerId || !serviceAccountEmail || !privateKeyPem) return undefined;

  return {
    issuerId,
    serviceAccountEmail,
    privateKeyPem,
    origins: (env.GOOGLE_WALLET_ORIGINS ?? "https://tarjeta.sophosgroup.com.py")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
