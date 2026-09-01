/**
 * Vencimiento de puntos.
 *
 * La consola deja configurar "los puntos vencen a los N meses" desde la
 * pantalla de Ajustes. Sin esto, esa configuración no hacía nada: el comercio
 * creía tener acotado el pasivo y no lo tenía. Un programa sin vencimiento
 * acumula una deuda que solo crece, y el comercio se entera el día que un
 * cliente aparece con tres años de puntos.
 *
 * **Qué vence, en criterio FIFO.** Los canjes consumen primero los puntos más
 * viejos, así que a la fecha de corte vence lo que se acumuló antes de esa
 * fecha y todavía no se consumió:
 *
 *     a vencer = acumulado antes del corte − todo lo ya consumido
 *
 * Ejemplo: 100 puntos hace 13 meses, 50 la semana pasada, 30 canjeados, corte a
 * los 12 meses. Vencen 70 y quedan 50 — los 30 canjeados salieron de los viejos.
 * Sin FIFO, el cliente que canjea seguido perdería puntos que ya había gastado.
 *
 * El resultado es un asiento `expire` como cualquier otro: el ledger sigue
 * siendo append-only y el saldo sigue siendo su proyección. Nada se "borra".
 */

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";
import { businessDay, tierFor, type ProgramConfig } from "@sophos/rules";

const DEFAULT_TIMEZONE = "America/Asuncion";

export interface ExpiredCard {
  membershipId: string;
  merchantId: string;
  expired: number;
  balanceAfter: number;
}

export interface ExpiryRun {
  /** Programas revisados: los que tienen vencimiento configurado. */
  programs: number;
  cards: ExpiredCard[];
}

interface Candidate {
  membership_id: string;
  merchant_id: string;
  balance: number;
  earned_before: number;
  consumed: number;
}

/**
 * Aplica el vencimiento de todos los programas que lo tengan configurado.
 *
 * `now` se inyecta para poder probarlo: un job que lee el reloj real solo se
 * puede testear esperando meses.
 */
export async function runExpiry(db: Db, now: Date = new Date()): Promise<ExpiryRun> {
  const programs = await rows<{ id: string; merchant_id: string; config: ProgramConfig }>(
    db.drizzle,
    sql`SELECT id, merchant_id, config FROM program
        WHERE status = 'active' AND config -> 'expiry' ->> 'months' IS NOT NULL`,
  );

  const cards: ExpiredCard[] = [];

  for (const program of programs) {
    const months = Number(program.config.expiry?.months);
    if (!Number.isInteger(months) || months <= 0) continue;

    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);

    // Se resuelve en una sola consulta por programa y no una por tarjeta: con
    // miles de socios, ir de a una sería un job que nunca termina.
    const candidates = await rows<Candidate>(
      db.drizzle,
      sql`SELECT m.id AS membership_id, m.merchant_id, m.balance,
                 COALESCE(SUM(l.amount) FILTER (
                   WHERE l.amount > 0 AND l.created_at < ${cutoff.toISOString()}
                 ), 0)::int AS earned_before,
                 COALESCE(-SUM(l.amount) FILTER (WHERE l.amount < 0), 0)::int AS consumed
          FROM membership m
          JOIN ledger_entry l ON l.membership_id = m.id
          WHERE m.program_id = ${program.id} AND m.status = 'active' AND m.balance > 0
          GROUP BY m.id, m.merchant_id, m.balance`,
    );

    for (const card of candidates) {
      // El tope por el saldo protege de un desfasaje: si por lo que sea las
      // cuentas no cerraran, es preferible vencer de menos que dejar el saldo
      // en negativo, que además viola el CHECK de la tabla.
      const toExpire = Math.min(Math.max(0, card.earned_before - card.consumed), card.balance);
      if (toExpire === 0) continue;

      const balanceAfter = card.balance - toExpire;
      const day = businessDay(
        now,
        program.config.timezone ?? DEFAULT_TIMEZONE,
        program.config.dayBoundaryHour ?? 0,
      );

      await db.drizzle.transaction(async (tx) => {
        // Asiento y saldo en la misma transacción, como todo movimiento: el
        // saldo es una proyección del ledger y no puede quedar suelto.
        await rows(
          tx,
          sql`INSERT INTO ledger_entry
                (membership_id, merchant_id, kind, amount, balance_after,
                 business_day, reason, actor)
              VALUES (${card.membership_id}, ${card.merchant_id}, 'expire',
                      ${-toExpire}, ${balanceAfter}, ${day},
                      ${`vencimiento a los ${months} meses`}, 'system')`,
        );

        await rows(
          tx,
          sql`UPDATE membership
              SET balance = ${balanceAfter},
                  tier = ${tierFor(program.config, balanceAfter)?.name ?? null}
              WHERE id = ${card.membership_id}`,
        );
      });

      cards.push({
        membershipId: card.membership_id,
        merchantId: card.merchant_id,
        expired: toExpire,
        balanceAfter,
      });
    }
  }

  return { programs: programs.length, cards };
}
