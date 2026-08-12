/**
 * Servicio de ledger: el único lugar del sistema que mueve saldos.
 *
 * Dos invariantes que sostienen todo lo demás:
 *
 * 1. **El asiento es la verdad, el saldo es una proyección.** `membership.balance`
 *    solo se escribe en la misma transacción que el asiento que lo justifica.
 *    Nunca se muta por fuera de acá.
 * 2. **Reprocesar un evento no cambia nada.** La unicidad de
 *    `(product_id, idempotency_key)` es lo que hace seguro que un POS con mala
 *    señal reintente: el segundo intento devuelve el resultado del primero.
 */

import { sql } from "drizzle-orm";

import { rows, type Db, type EventResult, type Executor } from "@sophos/db";
import {
  DEFAULT_TIMEZONE,
  businessDay,
  evaluateEarn,
  tierFor,
  type EventType,
  type ProgramConfig,
} from "@sophos/rules";

export interface ApplyEventInput {
  productId: string;
  merchantId: string;
  membershipId: string;
  /** Identificador del pedido en el producto de origen. */
  idempotencyKey: string;
  type: EventType;
  occurredAt: Date;
  /** Monto en la unidad mínima de la moneda. Para PYG, guaraníes enteros. */
  amount?: number;
  payload?: Record<string, unknown>;
}

export interface ApplyEventOutput extends EventResult {
  eventId: string;
  /** `true` si el evento ya había sido procesado antes. */
  duplicate: boolean;
  balance: number;
  tier: string | null;
}

interface MembershipRow {
  id: string;
  balance: number;
  merchant_id: string;
  program_id: string;
  config: ProgramConfig;
  program_status: "active" | "paused";
}

/** Carga la membresía y su programa, bloqueando la fila hasta el fin de la transacción. */
async function lockMembership(
  tx: Executor,
  membershipId: string,
  merchantId: string,
): Promise<MembershipRow | null> {
  // El bloqueo serializa las acumulaciones sobre una misma tarjeta. Sin él, dos
  // consumos simultáneos leerían el mismo acumulado del día y ambos pasarían el
  // tope diario.
  const found = await rows<MembershipRow>(
    tx,
    sql`SELECT m.id, m.balance, m.merchant_id, m.program_id,
               p.config, p.status AS program_status
        FROM membership m
        JOIN program p ON p.id = m.program_id
        WHERE m.id = ${membershipId}
          AND m.merchant_id = ${merchantId}
          AND m.status = 'active'
        FOR UPDATE OF m`,
  );

  return found[0] ?? null;
}

/** Suma ya acumulada por esta tarjeta en el día de negocio dado. */
async function earnedOn(
  tx: Executor,
  membershipId: string,
  day: string,
): Promise<number> {
  const found = await rows<{ earned: number }>(
    tx,
    sql`SELECT COALESCE(SUM(amount), 0)::int AS earned
        FROM ledger_entry
        WHERE membership_id = ${membershipId}
          AND kind = 'earn'
          AND business_day = ${day}`,
  );

  return found[0]?.earned ?? 0;
}

/** Cierra el evento guardando qué pasó, haya generado asiento o no. */
async function closeEvent(
  tx: Executor,
  eventId: string,
  result: EventResult,
): Promise<void> {
  await rows(
    tx,
    sql`UPDATE event
        SET processed_at = now(), result = ${JSON.stringify(result)}::jsonb
        WHERE id = ${eventId}`,
  );
}

/**
 * Ingresa un evento de negocio y acumula lo que corresponda.
 *
 * Reintentar con el mismo `idempotencyKey` devuelve el resultado del primer
 * intento sin volver a acumular.
 */
export async function applyEvent(
  db: Db,
  input: ApplyEventInput,
): Promise<ApplyEventOutput> {
  return db.drizzle.transaction(async (tx) => {
    // 1. La inserción del evento ES el candado de idempotencia. Si otra request
    //    idéntica llegó primero, `DO NOTHING` no devuelve fila.
    const inserted = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO event
            (product_id, merchant_id, membership_id, idempotency_key, type, payload, occurred_at)
          VALUES (${input.productId}, ${input.merchantId}, ${input.membershipId},
                  ${input.idempotencyKey}, ${input.type},
                  ${JSON.stringify(input.payload ?? {})}::jsonb,
                  ${input.occurredAt.toISOString()})
          ON CONFLICT (product_id, idempotency_key) DO NOTHING
          RETURNING id`,
    );

    if (!inserted[0]) {
      const previous = await rows<{ id: string; result: EventResult | null }>(
        tx,
        sql`SELECT id, result FROM event
            WHERE product_id = ${input.productId}
              AND idempotency_key = ${input.idempotencyKey}`,
      );
      const current = await rows<{ balance: number; tier: string | null }>(
        tx,
        sql`SELECT balance, tier FROM membership WHERE id = ${input.membershipId}`,
      );

      const result = previous[0]?.result;
      return {
        eventId: previous[0]?.id ?? "",
        duplicate: true,
        amount: result?.amount ?? 0,
        unit: result?.unit ?? "points",
        trace: result?.trace as EventResult["trace"],
        ledgerEntryId: result?.ledgerEntryId ?? null,
        ...(result?.skipped ? { skipped: result.skipped } : {}),
        balance: current[0]?.balance ?? 0,
        tier: current[0]?.tier ?? null,
      };
    }

    const eventId = inserted[0].id;
    const membership = await lockMembership(tx, input.membershipId, input.merchantId);

    if (!membership) {
      const result: EventResult = {
        amount: 0,
        unit: "points",
        trace: emptyTrace(input.occurredAt),
        ledgerEntryId: null,
        skipped: "no_membership",
      };
      await closeEvent(tx, eventId, result);
      return { eventId, duplicate: false, ...result, balance: 0, tier: null };
    }

    const config = membership.config;
    const timezone = config.timezone ?? DEFAULT_TIMEZONE;
    const day = businessDay(input.occurredAt, timezone, config.dayBoundaryHour ?? 0);

    if (membership.program_status !== "active") {
      const result: EventResult = {
        amount: 0,
        unit: config.kind === "stamps" ? "stamps" : "points",
        trace: emptyTrace(input.occurredAt, day),
        ledgerEntryId: null,
        skipped: "program_paused",
      };
      await closeEvent(tx, eventId, result);
      return {
        eventId,
        duplicate: false,
        ...result,
        balance: membership.balance,
        tier: null,
      };
    }

    // 2. Evaluar con el acumulado del día, para que el tope diario sea real.
    const evaluation = evaluateEarn(
      config,
      {
        type: input.type,
        occurredAt: input.occurredAt,
        ...(input.amount !== undefined ? { amount: input.amount } : {}),
      },
      {
        earnedToday: await earnedOn(tx, membership.id, day),
        currentBalance: membership.balance,
      },
    );

    // 3. Un evento que no movió el saldo no ensucia el ledger: su rastro queda
    //    en `event.result`, que es donde hay que mirar para explicar por qué un
    //    consumo no sumó puntos.
    if (evaluation.amount <= 0) {
      const result: EventResult = {
        amount: 0,
        unit: evaluation.unit,
        trace: evaluation.trace,
        ledgerEntryId: null,
        skipped: "zero_amount",
      };
      await closeEvent(tx, eventId, result);
      return {
        eventId,
        duplicate: false,
        ...result,
        balance: membership.balance,
        tier: null,
      };
    }

    const balanceAfter = membership.balance + evaluation.amount;

    const entry = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO ledger_entry
            (membership_id, merchant_id, kind, amount, balance_after,
             business_day, source_event_id, reason, trace, actor)
          VALUES (${membership.id}, ${membership.merchant_id}, 'earn',
                  ${evaluation.amount}, ${balanceAfter}, ${day}, ${eventId},
                  ${input.type}, ${JSON.stringify(evaluation.trace)}::jsonb, 'system')
          RETURNING id`,
    );

    const tier = tierFor(config, balanceAfter);

    await rows(
      tx,
      sql`UPDATE membership
          SET balance = ${balanceAfter}, tier = ${tier?.name ?? null}
          WHERE id = ${membership.id}`,
    );

    const result: EventResult = {
      amount: evaluation.amount,
      unit: evaluation.unit,
      trace: evaluation.trace,
      ledgerEntryId: entry[0]?.id ?? null,
    };
    await closeEvent(tx, eventId, result);

    return {
      eventId,
      duplicate: false,
      ...result,
      balance: balanceAfter,
      tier: tier?.name ?? null,
    };
  });
}

export interface RedeemInput {
  merchantId: string;
  membershipId: string;
  rewardId: string;
  /** Quién autorizó el canje: 'staff:<id>'. */
  redeemedBy: string;
}

export type RedeemOutput =
  | {
      ok: true;
      redemptionId: string;
      ledgerEntryId: string;
      balance: number;
      tier: string | null;
    }
  | {
      ok: false;
      reason: "membership_not_found" | "reward_not_found" | "insufficient_balance";
      balance: number;
      required?: number;
    };

/**
 * Canjea un beneficio.
 *
 * El beneficio tiene que pertenecer al mismo comercio que la tarjeta: es lo que
 * impide canjear el café gratis de un restaurante en el bar de al lado.
 */
export async function redeem(db: Db, input: RedeemInput): Promise<RedeemOutput> {
  return db.drizzle.transaction(async (tx): Promise<RedeemOutput> => {
    const membership = await lockMembership(tx, input.membershipId, input.merchantId);
    if (!membership) {
      return { ok: false, reason: "membership_not_found", balance: 0 };
    }

    const found = await rows<{ id: string; cost: number; name: string }>(
      tx,
      sql`SELECT id, cost, name FROM reward
          WHERE id = ${input.rewardId}
            AND merchant_id = ${input.merchantId}
            AND program_id = ${membership.program_id}
            AND status = 'active'`,
    );
    const reward = found[0];
    if (!reward) {
      return { ok: false, reason: "reward_not_found", balance: membership.balance };
    }

    if (membership.balance < reward.cost) {
      return {
        ok: false,
        reason: "insufficient_balance",
        balance: membership.balance,
        required: reward.cost,
      };
    }

    const balanceAfter = membership.balance - reward.cost;
    const config = membership.config;
    const day = businessDay(
      new Date(),
      config.timezone ?? DEFAULT_TIMEZONE,
      config.dayBoundaryHour ?? 0,
    );

    const entry = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO ledger_entry
            (membership_id, merchant_id, kind, amount, balance_after,
             business_day, reason, actor)
          VALUES (${membership.id}, ${membership.merchant_id}, 'redeem',
                  ${-reward.cost}, ${balanceAfter}, ${day},
                  ${`canje: ${reward.name}`}, ${input.redeemedBy})
          RETURNING id`,
    );
    const ledgerEntryId = entry[0]?.id;
    if (!ledgerEntryId) throw new Error("no se pudo registrar el asiento del canje");

    const redemption = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO redemption
            (membership_id, merchant_id, reward_id, ledger_entry_id, redeemed_by)
          VALUES (${membership.id}, ${membership.merchant_id}, ${reward.id},
                  ${ledgerEntryId}, ${input.redeemedBy})
          RETURNING id`,
    );

    const tier = tierFor(config, balanceAfter);
    await rows(
      tx,
      sql`UPDATE membership
          SET balance = ${balanceAfter}, tier = ${tier?.name ?? null}
          WHERE id = ${membership.id}`,
    );

    return {
      ok: true,
      redemptionId: redemption[0]?.id ?? "",
      ledgerEntryId,
      balance: balanceAfter,
      tier: tier?.name ?? null,
    };
  });
}

/**
 * Recalcula el saldo desde el ledger y lo compara con la proyección guardada.
 *
 * Es la red de seguridad de la invariante principal. Se usa en los tests y
 * debería correr como auditoría periódica: si alguna vez devuelve una
 * discrepancia, hay un camino de escritura que se saltó este servicio.
 */
export async function auditBalance(
  db: Db,
  membershipId: string,
): Promise<{ stored: number; computed: number; consistent: boolean }> {
  const found = await rows<{ stored: number; computed: number }>(
    db.drizzle,
    sql`SELECT m.balance AS stored,
               COALESCE((SELECT SUM(amount) FROM ledger_entry WHERE membership_id = m.id), 0)::int AS computed
        FROM membership m WHERE m.id = ${membershipId}`,
  );

  const stored = found[0]?.stored ?? 0;
  const computed = found[0]?.computed ?? 0;
  return { stored, computed, consistent: stored === computed };
}

function emptyTrace(occurredAt: Date, day?: string): EventResult["trace"] {
  return {
    base: 0,
    multiplier: 1,
    afterMultiplier: 0,
    cappedBy: null,
    matchedRules: [],
    businessDay: day ?? businessDay(occurredAt, DEFAULT_TIMEZONE, 0),
  };
}
