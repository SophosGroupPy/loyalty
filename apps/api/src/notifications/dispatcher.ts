/**
 * Encolado y despacho de notificaciones.
 *
 * Dos garantías que dan forma al módulo:
 *
 * 1. **Nada se pierde en silencio.** Cada intento deja una fila: la que se manda
 *    y también las que se agrupan o se descartan, con el motivo. Es lo que
 *    permite responderle a un comercio por qué su campaña llegó a 453 de 500.
 * 2. **Lo transaccional siempre tiene lugar.** Las campañas usan un cupo menor
 *    que el total, así que nunca pueden dejar sin aviso a un cliente que consume
 *    más tarde. Una notificación ya enviada no se puede devolver.
 */

import { sql } from "drizzle-orm";

import { rows, type Db, type Executor } from "@sophos/db";
import { DEFAULT_TIMEZONE, zonedParts, type NotificationSettings, type ProgramConfig } from "@sophos/rules";

import {
  budgetFor,
  dedupeKeyFor,
  isKindEnabled,
  isQuietHour,
  nextAllowedTime,
  PRIORITY,
  scheduleFor,
  type Channel,
  type NotificationKind,
} from "./policy.js";

export interface EnqueueInput {
  membershipId: string;
  merchantId: string;
  kind: NotificationKind;
  channel?: Channel;
  /** Para campañas: id de la campaña y el texto que escribió el comercio. */
  campaignId?: string;
  header?: string;
  body?: string;
  now?: Date;
}

export type EnqueueResult =
  | { status: "queued"; id: string; scheduledFor: Date }
  | { status: "coalesced"; id: string; into: string }
  | { status: "skipped"; reason: "opted_out" | "kind_disabled" | "card_inactive" };

interface MembershipContext {
  merchant_timezone: string;
  config: ProgramConfig;
  status: string;
  notification_optout: string[];
}

async function loadContext(
  executor: Executor,
  membershipId: string,
): Promise<MembershipContext | null> {
  const found = await rows<MembershipContext>(
    executor,
    sql`SELECT mer.timezone AS merchant_timezone, p.config, m.status, m.notification_optout
        FROM membership m
        JOIN merchant mer ON mer.id = m.merchant_id
        JOIN program p ON p.id = m.program_id
        WHERE m.id = ${membershipId}`,
  );
  return found[0] ?? null;
}

function settingsOf(config: ProgramConfig): NotificationSettings | undefined {
  return config?.notifications;
}

/**
 * Encola una notificación.
 *
 * El agrupamiento no se decide con un SELECT previo sino con el índice parcial
 * único de la base: dos consumos simultáneos sobre la misma tarjeta correrían
 * una carrera que el SELECT no ve, y ese es justamente el caso que hay que
 * agrupar.
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  const channel: Channel = input.channel ?? "wallet";
  const now = input.now ?? new Date();

  return db.drizzle.transaction(async (tx): Promise<EnqueueResult> => {
    const context = await loadContext(tx, input.membershipId);
    if (!context || context.status !== "active") {
      return { status: "skipped", reason: "card_inactive" };
    }
    if (context.notification_optout.includes(channel)) {
      return { status: "skipped", reason: "opted_out" };
    }

    const settings = settingsOf(context.config);
    // Las campañas las manda el comercio a mano: apagar los avisos automáticos
    // no puede silenciarlas.
    if (input.kind !== "campaign" && !isKindEnabled(input.kind, settings)) {
      return { status: "skipped", reason: "kind_disabled" };
    }

    const timezone = context.config?.timezone ?? context.merchant_timezone ?? DEFAULT_TIMEZONE;
    const scheduledFor = scheduleFor(input.kind, now, timezone, settings);
    const dedupeKey = dedupeKeyFor(input.kind, input.campaignId);

    const inserted = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO notification
            (membership_id, merchant_id, channel, kind, priority, dedupe_key,
             header, body, campaign_id, scheduled_for)
          VALUES (${input.membershipId}, ${input.merchantId}, ${channel}, ${input.kind},
                  ${PRIORITY[input.kind]}, ${dedupeKey}, ${input.header ?? null},
                  ${input.body ?? null}, ${input.campaignId ?? null},
                  ${scheduledFor.toISOString()})
          ON CONFLICT DO NOTHING
          RETURNING id`,
    );

    if (inserted[0]) {
      return { status: "queued", id: inserted[0].id, scheduledFor };
    }

    // Ya había una pendiente con la misma clave. Se registra igual, marcada como
    // agrupada: sin esta fila no habría forma de explicar por qué seis consumos
    // produjeron un solo aviso.
    const existing = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM notification
          WHERE membership_id = ${input.membershipId}
            AND channel = ${channel}
            AND dedupe_key = ${dedupeKey}
            AND sent_at IS NULL AND suppressed_reason IS NULL`,
    );
    const survivor = existing[0]?.id ?? null;

    const coalesced = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO notification
            (membership_id, merchant_id, channel, kind, priority, dedupe_key,
             header, body, campaign_id, scheduled_for, suppressed_reason, superseded_by)
          VALUES (${input.membershipId}, ${input.merchantId}, ${channel}, ${input.kind},
                  ${PRIORITY[input.kind]}, ${dedupeKey}, ${input.header ?? null},
                  ${input.body ?? null}, ${input.campaignId ?? null},
                  ${scheduledFor.toISOString()}, 'coalesced', ${survivor})
          RETURNING id`,
    );

    return { status: "coalesced", id: coalesced[0]?.id ?? "", into: survivor ?? "" };
  });
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

export interface RenderedNotification {
  id: string;
  membershipId: string;
  merchantId: string;
  channel: Channel;
  kind: NotificationKind;
  header: string;
  body: string;
  /**
   * `false` cuando la tarjeta ya gastó el cupo diario de Google.
   *
   * No cancela el aviso: Apple no tiene tope de plataforma, así que se entrega
   * igual por ahí. Es la diferencia entre "hoy no le podemos escribir" y "hoy no
   * le podemos escribir *por Google*".
   */
  allowGoogle: boolean;
}

/** A qué wallets entregó de verdad un envío. */
export interface SendOutcome {
  apple: boolean;
  google: boolean;
}

export interface NotificationSender {
  send(notification: RenderedNotification): Promise<SendOutcome>;
}

/**
 * La tarjeta no tiene pase instalado en ninguna wallet.
 *
 * Lo lanza el canal cuando ni Google ni Apple tienen dónde entregar. No es un
 * fallo de envío —no se rompió nada—, es la ausencia de un destino; el
 * despachador lo registra aparte para que el comercio no lea "falló" cuando la
 * verdad es "esta persona todavía no agregó la tarjeta".
 */
export class NoInstalledPassError extends Error {
  constructor() {
    super("La tarjeta no tiene pase instalado en ninguna wallet.");
    this.name = "NoInstalledPassError";
  }
}

export interface DispatchReport {
  sent: number;
  suppressed: Record<string, number>;
  rescheduled: number;
  failed: number;
}

interface DueRow {
  id: string;
  membership_id: string;
  merchant_id: string;
  channel: Channel;
  kind: NotificationKind;
  header: string | null;
  body: string | null;
  created_at: string;
}

/**
 * Despacha lo que esté vencido, en orden de prioridad.
 *
 * Procesar por prioridad es lo que hace que, cuando el cupo escasea, se caiga la
 * campaña y no el aviso de que el cliente ganó un beneficio.
 */
export async function dispatchDue(
  db: Db,
  sender: NotificationSender,
  options: { now?: Date; limit?: number } = {},
): Promise<DispatchReport> {
  const now = options.now ?? new Date();
  const report: DispatchReport = { sent: 0, suppressed: {}, rescheduled: 0, failed: 0 };

  const due = await rows<DueRow>(
    db.drizzle,
    sql`SELECT id, membership_id, merchant_id, channel, kind, header, body, created_at
        FROM notification
        WHERE sent_at IS NULL AND suppressed_reason IS NULL
          AND scheduled_for <= ${now.toISOString()}
        ORDER BY priority ASC, scheduled_for ASC
        LIMIT ${options.limit ?? 200}`,
  );

  for (const item of due) {
    const outcome = await processOne(db, sender, item, now);

    if (outcome === "sent") report.sent += 1;
    else if (outcome === "rescheduled") report.rescheduled += 1;
    else if (outcome === "send_failed") report.failed += 1;
    else report.suppressed[outcome] = (report.suppressed[outcome] ?? 0) + 1;
  }

  return report;
}

type Outcome =
  | "sent"
  | "rescheduled"
  | "send_failed"
  | "no_installed_pass"
  | "opted_out"
  | "card_inactive"
  | "budget_exhausted";

/** O se cierra el aviso con un motivo, o se manda diciendo si Google entra. */
type Decision = Outcome | { allowGoogle: boolean };

async function processOne(
  db: Db,
  sender: NotificationSender,
  item: DueRow,
  now: Date,
): Promise<Outcome> {
  const decision = await db.drizzle.transaction(async (tx): Promise<Decision> => {
    // Se relee bloqueando: entre el listado y el procesamiento otro worker pudo
    // haber tomado la misma fila.
    const still = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM notification
          WHERE id = ${item.id} AND sent_at IS NULL AND suppressed_reason IS NULL
          FOR UPDATE SKIP LOCKED`,
    );
    if (!still[0]) return "budget_exhausted";

    const context = await loadContext(tx, item.membership_id);
    if (!context || context.status !== "active") {
      await suppress(tx, item.id, "card_inactive");
      return "card_inactive";
    }
    if (context.notification_optout.includes(item.channel)) {
      await suppress(tx, item.id, "opted_out");
      return "opted_out";
    }

    const settings = settingsOf(context.config);
    const timezone = context.config?.timezone ?? context.merchant_timezone ?? DEFAULT_TIMEZONE;

    // La franja de silencio se revisa otra vez al despachar: un aviso encolado
    // hace horas pudo haber entrado en ella mientras esperaba.
    const quiet = settings?.quietHours;
    if (quiet && isQuietHour(zonedParts(now, timezone).hour, quiet)) {
      const next = nextAllowedTime(now, timezone, settings);
      await rows(
        tx,
        sql`UPDATE notification SET scheduled_for = ${next.toISOString()} WHERE id = ${item.id}`,
      );
      return "rescheduled";
    }

    // El cupo cuenta entregas a GOOGLE, no avisos enviados. Un aviso que salió
    // solo por Apple no gasta cupo: el tope de 3/24 h lo impone Google, y Apple
    // no tiene ninguno.
    //
    // Ya no se suprime el aviso acá: quedarse sin cupo de Google no es quedarse
    // sin destino. Se le avisa al canal con `allowGoogle` y él decide —es el
    // único que sabe qué wallets tiene puestas esta tarjeta—. Si tampoco había
    // Apple, el canal lo dice lanzando `NoInstalledPassError`, y recién ahí se
    // registra el motivo.
    const usado = await rows<{ count: number }>(
      tx,
      sql`SELECT count(*)::int AS count FROM notification
          WHERE membership_id = ${item.membership_id}
            AND channel = ${item.channel}
            AND google_sent_at > ${new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()}`,
    );

    return { allowGoogle: (usado[0]?.count ?? 0) < budgetFor(item.kind) };
  });

  if (typeof decision === "string") return decision;

  const rendered = await render(db, item, decision.allowGoogle);

  let entrega: SendOutcome;
  try {
    entrega = await sender.send(rendered);
  } catch (error) {
    // "No hay pase instalado" no es un fallo de envío: es que la persona no
    // agregó la tarjeta a ninguna wallet. Se registra aparte para que el reporte
    // lo distinga de algo que sí se rompió.
    const noTarget = error instanceof NoInstalledPassError;
    // Sin destino y con Google salteado por cupo, el motivo honesto es el cupo y
    // no "todavía no agregó la tarjeta". El cupo solo puede estar agotado si ya
    // hubo entregas a Google, así que llegar acá implica que sí tenía pase de
    // Google y que lo que faltó fue lugar, no tarjeta.
    const reason: Outcome = !noTarget
      ? "send_failed"
      : decision.allowGoogle
        ? "no_installed_pass"
        : "budget_exhausted";
    const message = error instanceof Error ? error.message : String(error);
    await rows(
      db.drizzle,
      sql`UPDATE notification
          SET suppressed_reason = ${reason}, last_error = ${noTarget ? null : message}
          WHERE id = ${item.id}`,
    );
    return reason;
  }

  // `google_sent_at` solo si Google entregó: es lo que consume cupo. Un aviso que
  // salió únicamente por Apple queda con `sent_at` y sin cupo gastado.
  await rows(
    db.drizzle,
    sql`UPDATE notification
        SET sent_at = ${now.toISOString()},
            google_sent_at = ${entrega.google ? now.toISOString() : null}
        WHERE id = ${item.id}`,
  );
  return "sent";
}

async function suppress(tx: Executor, id: string, reason: string): Promise<void> {
  await rows(tx, sql`UPDATE notification SET suppressed_reason = ${reason} WHERE id = ${id}`);
}

/**
 * Arma el texto en el momento de mandar, no al encolar.
 *
 * Es lo que hace útil el agrupamiento: si el cliente consumió tres veces desde
 * que se encoló el aviso, recibe el saldo final y el total acumulado, no el
 * primero de los tres.
 */
async function render(
  db: Db,
  item: DueRow,
  allowGoogle: boolean,
): Promise<RenderedNotification> {
  const base = {
    id: item.id,
    membershipId: item.membership_id,
    merchantId: item.merchant_id,
    channel: item.channel,
    kind: item.kind,
    allowGoogle,
  };

  if (item.kind === "campaign") {
    return { ...base, header: item.header ?? "", body: item.body ?? "" };
  }

  const state = await rows<{
    balance: number;
    tier: string | null;
    kind: "points" | "stamps";
    merchant: string;
    accrued: number;
  }>(
    db.drizzle,
    // Lo acumulado se cuenta **desde el último aviso enviado**, no desde que se
    // encoló éste. La diferencia importa: el aviso se encola después de escribir
    // el asiento que lo motivó, así que contar desde su creación dejaría afuera
    // justamente el consumo que lo disparó.
    sql`SELECT m.balance, m.tier, p.kind, mer.display_name AS merchant,
               COALESCE((
                 SELECT SUM(amount) FROM ledger_entry
                 WHERE membership_id = m.id AND kind = 'earn'
                   AND created_at > COALESCE((
                     SELECT MAX(sent_at) FROM notification
                     WHERE membership_id = m.id
                       AND kind = 'balance_changed'
                       AND sent_at IS NOT NULL
                   ), '-infinity'::timestamptz)
               ), 0)::int AS accrued
        FROM membership m
        JOIN program p ON p.id = m.program_id
        JOIN merchant mer ON mer.id = m.merchant_id
        WHERE m.id = ${item.membership_id}`,
  );

  const card = state[0];
  const unit = card?.kind === "stamps" ? "sellos" : "puntos";
  const balance = card?.balance ?? 0;
  const header = card?.merchant ?? "";

  if (item.kind === "balance_changed") {
    const accrued = card?.accrued ?? 0;
    return {
      ...base,
      header,
      body: accrued > 0
        ? `Sumaste ${accrued} ${unit}. Ya tenés ${balance}.`
        : `Tenés ${balance} ${unit}.`,
    };
  }

  if (item.kind === "tier_changed") {
    return { ...base, header, body: `Subiste al nivel ${card?.tier ?? ""}.` };
  }

  if (item.kind === "reward_unlocked") {
    const reward = await rows<{ name: string }>(
      db.drizzle,
      sql`SELECT name FROM reward
          WHERE merchant_id = ${item.merchant_id} AND status = 'active' AND cost <= ${balance}
          ORDER BY cost DESC LIMIT 1`,
    );
    return {
      ...base,
      header,
      body: reward[0]
        ? `¡Ya podés canjear: ${reward[0].name}!`
        : `Tenés ${balance} ${unit} para canjear.`,
    };
  }

  return { ...base, header, body: `Tenés ${balance} ${unit}.` };
}

/**
 * Resultado de una campaña, con la entrega real.
 *
 * El comercio necesita ver "llegó a 453 de 500" y no un "enviado" plano: como el
 * cupo es por tarjeta, a quien ya consumió varias veces ese día no le entra, y
 * decidir sobre el número equivocado lleva a conclusiones equivocadas.
 */
export async function campaignReport(
  db: Db,
  campaignId: string,
): Promise<{ targeted: number; delivered: number; pending: number; suppressed: Record<string, number> }> {
  const stats = await rows<{ sent_at: string | null; suppressed_reason: string | null }>(
    db.drizzle,
    sql`SELECT sent_at, suppressed_reason FROM notification WHERE campaign_id = ${campaignId}`,
  );

  const suppressed: Record<string, number> = {};
  let delivered = 0;
  let pending = 0;

  for (const row of stats) {
    if (row.sent_at) delivered += 1;
    else if (row.suppressed_reason) {
      suppressed[row.suppressed_reason] = (suppressed[row.suppressed_reason] ?? 0) + 1;
    } else pending += 1;
  }

  return { targeted: stats.length, delivered, pending, suppressed };
}
