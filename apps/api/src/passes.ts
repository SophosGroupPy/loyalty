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
  issueGooglePass(membershipId: string, merchantId: string): Promise<IssueOutcome>;
  /**
   * Empuja el saldo al pase.
   *
   * **No notifica por defecto**, y es deliberado: mantener la tarjeta al día es
   * una operación silenciosa que corre en cada acumulación, mientras que avisarle
   * al cliente consume un cupo escaso que administra el despachador. Si esto
   * notificara solo, seis consumos en una noche gastarían el cupo del día entero
   * sin que nadie lo decidiera.
   */
  syncGooglePass(membershipId: string, options?: { notify?: boolean }): Promise<SyncOutcome>;
  /**
   * Re-registra la clase de Google del comercio con su diseño actual.
   *
   * Los colores, el logo, la imagen y las geocercas viven en la **clase**, no en
   * cada tarjeta, así que una sola llamada actualiza todas las tarjetas del
   * comercio a la vez. `syncGooglePass` no sirve para esto: parchea el objeto
   * (los puntos) y encima corta si el saldo no cambió, que es justo lo que pasa
   * cuando lo único que cambió fue el diseño.
   */
  refreshGoogleClass(merchantId: string): Promise<{ status: "updated" | "skipped"; reason?: string }>;
  /** Manda un mensaje visible al pase. Es la vía de las notificaciones. */
  sendMessage(
    membershipId: string,
    message: { id: string; header: string; body: string },
  ): Promise<void>;
  /** Con `productId`, se limita a los pases de ese producto. */
  pendingSync(
    limit?: number,
    productId?: string,
  ): Promise<{ membershipId: string; drift: number }[]>;
}

export interface IssueOutcome {
  saveUrl: string;
  /**
   * `false` si no se pudo registrar la clase en Google.
   *
   * El link igual sirve para guardar la tarjeta, porque la clase viaja adentro.
   * Pero sin la clase registrada **las actualizaciones posteriores no llegan**:
   * el saldo queda congelado en el valor de emisión. Hay que exponerlo, no
   * tragarlo — un "emitido con éxito" sobre esto sería mentira.
   */
  classRegistered: boolean;
  classError?: string;
}

export type SyncOutcome =
  | { status: "synced"; balance: number }
  | { status: "skipped"; reason: "no_pass" | "disabled" | "already_current" }
  | { status: "failed"; error: string };

interface CardRow {
  product_name: string;
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
  issued_at: Date;
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
                 m.display_name AS holder_name, m.issued_at,
                 mer.slug AS merchant_slug, mer.display_name, mer.legal_name, mer.design,
                 prod.name AS product_name,
                 p.kind AS program_kind
          FROM membership m
          JOIN merchant mer ON mer.id = m.merchant_id
          JOIN product prod ON prod.id = mer.product_id
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
      // Del producto dueño del comercio, no fija: la misma API sirve a elMenú,
      // Noctu y FactuFast.
      attribution: stored.attribution || `Powered by ${card.product_name}`,
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
        attribution: design.attribution,
        tier: card.tier,
        memberSince: new Date(card.issued_at).toISOString(),
      });

      // La clase se registra por API además de viajar en el link: el link basta
      // para el primer guardado, pero las actualizaciones de saldo necesitan que
      // la clase exista del lado de Google.
      let classRegistered = true;
      let classError: string | undefined;

      if (client) {
        try {
          await client.upsertClass(loyaltyClass);
        } catch (error) {
          // Que falle el registro no impide entregar el link —el pase viaja
          // completo adentro—, pero sí se informa: una tarjeta que nunca va a
          // actualizarse no es una emisión exitosa.
          classRegistered = false;
          classError = messageOf(error);
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

      return {
        saveUrl: link,
        classRegistered,
        ...(classError ? { classError } : {}),
      };
    },

    /**
     * Empuja el saldo actual al pase.
     *
     * Nunca lanza: un fallo queda registrado en `pass_instance.last_error` y el
     * desfasaje se detecta comparando `last_synced_balance` con el saldo real.
     */
    async syncGooglePass(membershipId, options = {}) {
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
          // Silencioso salvo que se pida lo contrario: quién recibe un aviso y
          // cuándo lo decide el despachador, que es el único que ve el cupo.
          notify: options.notify ?? false,
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

    async refreshGoogleClass(merchantId) {
      if (!client || !config) return { status: "skipped", reason: "disabled" };

      const found = await rows<{
        slug: string;
        display_name: string;
        legal_name: string;
        design: CardDesign | null;
        product_name: string;
        program_kind: "points" | "stamps" | null;
      }>(
        db.drizzle,
        sql`SELECT mer.slug, mer.display_name, mer.legal_name, mer.design,
                   prod.name AS product_name, p.kind AS program_kind
            FROM merchant mer
            JOIN product prod ON prod.id = mer.product_id
            LEFT JOIN program p ON p.merchant_id = mer.id AND p.status = 'active'
            WHERE mer.id = ${merchantId}`,
      );
      const mer = found[0];
      if (!mer) return { status: "skipped", reason: "no_merchant" };

      const design = designOf({
        design: mer.design,
        display_name: mer.display_name,
        product_name: mer.product_name,
        program_kind: mer.program_kind ?? "points",
      } as CardRow);

      const loyaltyClass = buildLoyaltyClass({
        issuerId: config.issuerId,
        merchant: { slug: mer.slug, displayName: mer.display_name, legalName: mer.legal_name },
        design,
        locations: await loadLocations(merchantId),
      });

      await client.upsertClass(loyaltyClass);
      return { status: "updated" };
    },

    /**
     * Manda un mensaje visible al pase.
     *
     * Va por `addMessage` con `TEXT_AND_NOTIFY` en vez de por un cambio de campo:
     * sirve para cualquier tipo de aviso (no solo cambios de saldo), y evita
     * depender de `notifyPreference`, cuyo valor la documentación de Google
     * define de forma contradictoria.
     */
    async sendMessage(membershipId, message) {
      if (!client) throw new Error("Google Wallet no está configurado.");

      const pass = await rows<{ external_id: string }>(
        db.drizzle,
        sql`SELECT external_id FROM pass_instance
            WHERE membership_id = ${membershipId} AND platform = 'google' AND state = 'active'`,
      );
      const instance = pass[0];
      if (!instance) throw new Error("La tarjeta no tiene pase de Google emitido.");

      await client.addMessage(instance.external_id, { ...message, notify: true });
    },

    /**
     * Tarjetas cuyo pase quedó atrás del saldo real.
     *
     * Es la cola de reconciliación: si Google estuvo caído mientras se acumulaba,
     * acá aparecen los pases a reintentar.
     */
    async pendingSync(limit = 100, productId?: string) {
      const found = await rows<{ membership_id: string; drift: number }>(
        db.drizzle,
        sql`SELECT pi.membership_id,
                   (m.balance - COALESCE(pi.last_synced_balance, 0)) AS drift
            FROM pass_instance pi
            JOIN membership m ON m.id = pi.membership_id
            JOIN merchant mer ON mer.id = pi.merchant_id
            WHERE pi.state = 'active'
              AND pi.platform = 'google'
              AND m.balance IS DISTINCT FROM pi.last_synced_balance
              -- Sin productId devuelve todo el ecosistema: solo lo llama el
              -- back-office. Los productos siempre lo pasan.
              AND (${productId ?? null}::uuid IS NULL OR mer.product_id = ${productId ?? null}::uuid)
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
