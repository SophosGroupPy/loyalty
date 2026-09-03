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
      // El monto va en su propia columna, no solo dentro del payload: es lo que
      // permite derivar visitas, gasto y ticket promedio desde los datos que
      // loyalty ya recibe, sin necesidad de importar el CRM del producto.
      sql`INSERT INTO event
            (product_id, merchant_id, membership_id, idempotency_key, type, payload,
             amount, occurred_at)
          VALUES (${input.productId}, ${input.merchantId}, ${input.membershipId},
                  ${input.idempotencyKey}, ${input.type},
                  ${JSON.stringify(input.payload ?? {})}::jsonb,
                  ${input.amount ?? null},
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
      reason:
        | "membership_not_found"
        | "reward_not_found"
        | "insufficient_balance"
        | "tier_locked";
      balance: number;
      required?: number;
      /** En `tier_locked`, el nivel que el beneficio exige. */
      requiredTier?: string;
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

    const found = await rows<{ id: string; cost: number; name: string; min_tier: string | null }>(
      tx,
      sql`SELECT id, cost, name, min_tier FROM reward
          WHERE id = ${input.rewardId}
            AND merchant_id = ${input.merchantId}
            AND program_id = ${membership.program_id}
            AND status = 'active'`,
    );
    const reward = found[0];
    if (!reward) {
      return { ok: false, reason: "reward_not_found", balance: membership.balance };
    }

    // Beneficio bloqueado por nivel: el cliente tiene que haber alcanzado el
    // nivel que el beneficio exige. Se resuelve el umbral desde la config del
    // programa —el comercio guardó un nombre, "Oro", no un número— y se compara
    // contra el saldo actual. Si el nivel ya no existe (lo renombraron o lo
    // borraron), el candado queda sin efecto en vez de trabar un canje legítimo:
    // penalizar al cliente por un cambio de configuración del comercio sería el
    // peor de los dos errores.
    if (reward.min_tier) {
      const config = membership.config;
      const requerido =
        config.kind === "points"
          ? config.tiers?.find((t) => t.name === reward.min_tier)
          : undefined;
      if (requerido && membership.balance < requerido.min) {
        return {
          ok: false,
          reason: "tier_locked",
          balance: membership.balance,
          requiredTier: reward.min_tier,
        };
      }
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
    tierMultiplier: 1,
    afterMultiplier: 0,
    cappedBy: null,
    matchedRules: [],
    businessDay: day ?? businessDay(occurredAt, DEFAULT_TIMEZONE, 0),
  };
}

export interface BalanceDiscrepancy {
  membershipId: string;
  merchantId: string;
  serialNumber: string;
  stored: number;
  computed: number;
}

/**
 * Busca tarjetas cuyo saldo guardado no coincida con la suma de sus asientos.
 *
 * Es la red de seguridad de la invariante principal: el saldo es una proyección
 * del ledger y solo se escribe en la misma transacción que el asiento. Si esto
 * alguna vez devuelve algo, hay un camino de escritura que se saltó el servicio
 * de ledger — y el momento de enterarse es ahora, no cuando un comercio discute
 * el saldo de un cliente.
 *
 * Se resuelve en una sola consulta y no una por tarjeta: con decenas de miles
 * de socios, ir de a una sería un job que nunca termina.
 */
export async function auditAllBalances(
  db: Db,
  limit = 100,
): Promise<BalanceDiscrepancy[]> {
  const found = await rows<{
    membership_id: string;
    merchant_id: string;
    serial_number: string;
    stored: number;
    computed: number;
  }>(
    db.drizzle,
    sql`SELECT m.id AS membership_id, m.merchant_id, m.serial_number,
               m.balance AS stored,
               COALESCE(SUM(l.amount), 0)::int AS computed
        FROM membership m
        LEFT JOIN ledger_entry l ON l.membership_id = m.id
        GROUP BY m.id, m.merchant_id, m.serial_number, m.balance
        HAVING m.balance <> COALESCE(SUM(l.amount), 0)
        LIMIT ${limit}`,
  );

  return found.map((r) => ({
    membershipId: r.membership_id,
    merchantId: r.merchant_id,
    serialNumber: r.serial_number,
    stored: r.stored,
    computed: r.computed,
  }));
}

export interface ReverseEventInput {
  productId: string;
  merchantId: string;
  /** La misma clave con la que se registró el consumo. */
  idempotencyKey: string;
  reason?: string;
}

export type ReverseEventOutput =
  | {
      status: "reversed";
      ledgerEntryId: string;
      /** Para que quien llama pueda sincronizar el pase sin volver a buscarla. */
      membershipId: string;
      /** Cuánto se pudo descontar de verdad. */
      reversed: number;
      /**
       * Cuánto NO se pudo recuperar porque el cliente ya lo había canjeado.
       *
       * Se informa en vez de esconderse: es plata que el comercio entregó por
       * un consumo que no existió, y tiene derecho a saberlo.
       */
      notRecovered: number;
      balance: number;
      tier: string | null;
      /** `true` si ya se había revertido antes. */
      duplicate: boolean;
    }
  | { status: "not_found" }
  | { status: "nothing_to_reverse" };

/**
 * Deshace la acumulación de un consumo que se anuló, se invitó o no se entregó.
 *
 * **Es un asiento nuevo, no un borrado.** El ledger es append-only: la
 * acumulación original queda, y encima va un `adjust` negativo. Así el historial
 * sigue explicando qué pasó, que es lo que permite responder un reclamo.
 *
 * **Si el cliente ya gastó los puntos, se descuenta lo que haya y nada más.**
 * No se puede des-tomar el café que ya se canjeó, y dejar el saldo en negativo
 * violaría el invariante de la tarjeta además de ser incomprensible para el
 * cliente. Lo que no se pudo recuperar se devuelve en `notRecovered` para que
 * el comercio lo vea: es plata que entregó por un consumo que no existió.
 *
 * Idempotente por evento: revertir dos veces devuelve el primer resultado.
 */
export async function reverseEvent(
  db: Db,
  input: ReverseEventInput,
): Promise<ReverseEventOutput> {
  return db.drizzle.transaction(async (tx): Promise<ReverseEventOutput> => {
    const eventos = await rows<{ id: string; membership_id: string | null }>(
      tx,
      sql`SELECT id, membership_id FROM event
          WHERE product_id = ${input.productId}
            AND idempotency_key = ${input.idempotencyKey}
            AND merchant_id = ${input.merchantId}`,
    );

    const evento = eventos[0];
    if (!evento || !evento.membership_id) return { status: "not_found" };

    // El asiento original. Sin él no hubo acumulación que deshacer: pasa cuando
    // el consumo no sumó puntos por el tope diario o por no llegar al mínimo.
    const originales = await rows<{ id: string; amount: number }>(
      tx,
      sql`SELECT id, amount FROM ledger_entry
          WHERE source_event_id = ${evento.id} AND kind = 'earn'`,
    );

    const original = originales[0];
    if (!original) return { status: "nothing_to_reverse" };

    const membresias = await rows<{
      id: string;
      merchant_id: string;
      balance: number;
      config: ProgramConfig;
    }>(
      tx,
      sql`SELECT m.id, m.merchant_id, m.balance, p.config
          FROM membership m JOIN program p ON p.id = m.program_id
          WHERE m.id = ${evento.membership_id}`,
    );

    const membresia = membresias[0];
    if (!membresia) return { status: "not_found" };

    // Ya revertido: se devuelve lo que quedó, sin escribir de nuevo. La reversa
    // puede reintentarse desde el producto de origen y no puede descontar dos
    // veces.
    //
    // El vínculo con el evento va en `trace` y no en `source_event_id`: ese
    // campo tiene un índice único —"un asiento por evento", la segunda línea de
    // defensa de la idempotencia— y el asiento de acumulación ya lo ocupa. El
    // propio trigger de append-only lo dice: "para revertir, insertá un asiento
    // de ajuste".
    const previas = await rows<{ id: string; amount: number }>(
      tx,
      sql`SELECT id, amount FROM ledger_entry
          WHERE membership_id = ${evento.membership_id}
            AND kind = 'adjust'
            AND trace ->> 'reverses' = ${evento.id}`,
    );

    if (previas[0]) {
      return {
        status: "reversed",
        ledgerEntryId: previas[0].id,
        membershipId: membresia.id,
        reversed: Math.abs(previas[0].amount),
        notRecovered: original.amount - Math.abs(previas[0].amount),
        balance: membresia.balance,
        tier: tierFor(membresia.config, membresia.balance)?.name ?? null,
        duplicate: true,
      };
    }

    // Acá está la decisión: se descuenta lo que haya, no lo que se acreditó.
    const aDescontar = Math.min(original.amount, membresia.balance);
    const balanceAfter = membresia.balance - aDescontar;

    if (aDescontar === 0) {
      // El ledger rechaza asientos en cero, y con razón: un movimiento que no
      // movió nada no es un movimiento. Se informa sin escribir.
      return {
        status: "reversed",
        ledgerEntryId: "",
        membershipId: membresia.id,
        reversed: 0,
        notRecovered: original.amount,
        balance: membresia.balance,
        tier: tierFor(membresia.config, membresia.balance)?.name ?? null,
        duplicate: false,
      };
    }

    const config = membresia.config;
    const day = businessDay(
      new Date(),
      config.timezone ?? DEFAULT_TIMEZONE,
      config.dayBoundaryHour ?? 0,
    );

    const asiento = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO ledger_entry
            (membership_id, merchant_id, kind, amount, balance_after,
             business_day, source_event_id, reason, trace, actor)
          VALUES (${membresia.id}, ${membresia.merchant_id}, 'adjust',
                  ${-aDescontar}, ${balanceAfter}, ${day}, NULL,
                  ${input.reason ?? "reversa del consumo"},
                  ${JSON.stringify({
                    reverses: evento.id,
                    originalEntry: original.id,
                    accrued: original.amount,
                    notRecovered: original.amount - aDescontar,
                  })}::jsonb, 'system')
          RETURNING id`,
    );

    const tier = tierFor(config, balanceAfter);

    await rows(
      tx,
      sql`UPDATE membership SET balance = ${balanceAfter}, tier = ${tier?.name ?? null}
          WHERE id = ${membresia.id}`,
    );

    return {
      status: "reversed",
      ledgerEntryId: asiento[0]?.id ?? "",
      membershipId: membresia.id,
      reversed: aDescontar,
      notRecovered: original.amount - aDescontar,
      balance: balanceAfter,
      tier: tier?.name ?? null,
      duplicate: false,
    };
  });
}

/**
 * Pone al día el nivel guardado de todas las tarjetas de un comercio.
 *
 * `membership.tier` es una proyección: normalmente se recalcula en cada
 * movimiento del ledger, sobre el saldo resultante. Pero cuando el comercio
 * cambia los NIVELES —agrega uno, mueve un umbral, los apaga— no hay ningún
 * movimiento, así que el nivel guardado queda viejo. Una tarjeta que con la
 * config nueva calificaría para Oro seguiría mostrando el nivel anterior (o
 * ninguno) hasta la próxima compra del cliente. Esto lo corrige de una.
 *
 * Es un solo UPDATE con un CASE armado desde los niveles ordenados por umbral
 * descendente: la primera condición que cumple el saldo gana, que es
 * exactamente la semántica de `tierFor`. Sin niveles, todo queda en null.
 */
export async function recomputeMemberTiers(
  db: Db,
  merchantId: string,
  config: ProgramConfig,
): Promise<void> {
  const niveles =
    config.kind === "points" && config.tiers ? [...config.tiers] : [];

  if (niveles.length === 0) {
    await rows(
      db.drizzle,
      sql`UPDATE membership SET tier = NULL
          WHERE merchant_id = ${merchantId} AND status = 'active' AND tier IS NOT NULL`,
    );
    return;
  }

  niveles.sort((a, b) => b.min - a.min);
  const whens = niveles.map((t) => sql`WHEN balance >= ${t.min} THEN ${t.name}`);

  await rows(
    db.drizzle,
    sql`UPDATE membership
        SET tier = CASE ${sql.join(whens, sql` `)} ELSE NULL END
        WHERE merchant_id = ${merchantId} AND status = 'active'`,
  );
}
