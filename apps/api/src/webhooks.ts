/**
 * Entrega de webhooks hacia los productos.
 *
 * Sigue la misma regla que la sincronización de pases: **una caída del producto
 * no puede hacer fallar la operación que disparó el aviso.** El cliente ya
 * consumió; que ElMenu esté caído no puede convertir eso en un error. Por eso la
 * entrega se encola y se reintenta aparte.
 *
 * La firma vive en `@sophos/loyalty-sdk`, el mismo módulo que usa el producto
 * para verificar. Compartir el código es lo que impide que firmante y
 * verificador discrepen en algún detalle.
 */

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";
import { signPayload, type WebhookEventType } from "@sophos/loyalty-sdk";

/**
 * Espera entre reintentos, en minutos.
 *
 * Crece rápido a propósito: si un producto está caído, martillarlo cada minuto
 * no lo levanta y sí llena su log. Cinco intentos cubren unas ocho horas, que
 * alcanza para un incidente normal sin retener entregas para siempre.
 */
const BACKOFF_MINUTES = [1, 5, 30, 120, 360];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

export interface EnqueueWebhookInput {
  productId: string;
  merchantId: string;
  type: WebhookEventType;
  data: Record<string, unknown>;
  now?: Date;
}

/**
 * Encola un evento para todos los endpoints suscriptos del producto.
 *
 * No hace red: solo escribe filas. La entrega la hace `deliverDue`.
 */
export async function enqueueWebhook(
  db: Db,
  input: EnqueueWebhookInput,
): Promise<number> {
  const endpoints = await rows<{ id: string }>(
    db.drizzle,
    sql`SELECT id FROM webhook_endpoint
        WHERE product_id = ${input.productId} AND active
          -- Un arreglo vacío significa "todos los eventos".
          AND (cardinality(event_types) = 0 OR ${input.type} = ANY (event_types))`,
  );

  if (endpoints.length === 0) return 0;

  const merchant = await rows<{ external_id: string }>(
    db.drizzle,
    sql`SELECT external_id FROM merchant WHERE id = ${input.merchantId}`,
  );

  // El producto conoce a sus comercios por el id de SU sistema, no por el UUID
  // interno de loyalty. Mandarle el UUID lo obligaría a mantener una tabla de
  // traducción que no tiene por qué existir.
  const payload = {
    type: input.type,
    merchant: merchant[0]?.external_id ?? null,
    occurredAt: (input.now ?? new Date()).toISOString(),
    data: input.data,
  };

  for (const endpoint of endpoints) {
    await rows(
      db.drizzle,
      sql`INSERT INTO webhook_delivery (endpoint_id, merchant_id, event_type, payload)
          VALUES (${endpoint.id}, ${input.merchantId}, ${input.type},
                  ${JSON.stringify(payload)}::jsonb)`,
    );
  }

  return endpoints.length;
}

export interface DeliveryReport {
  attempted: number;
  delivered: number;
  failed: number;
  exhausted: number;
}

interface DueDelivery {
  id: string;
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  url: string;
  secret: string;
}

/**
 * Entrega las que estén vencidas.
 *
 * Nunca lanza por una entrega fallida: registra el error y reprograma. Una sola
 * URL rota no puede frenar la cola de los demás productos.
 */
export async function deliverDue(
  db: Db,
  options: { now?: Date; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<DeliveryReport> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const report: DeliveryReport = { attempted: 0, delivered: 0, failed: 0, exhausted: 0 };

  const due = await rows<DueDelivery>(
    db.drizzle,
    sql`SELECT d.id, d.event_id, d.event_type, d.payload, d.attempts, e.url, e.secret
        FROM webhook_delivery d
        JOIN webhook_endpoint e ON e.id = d.endpoint_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ${now.toISOString()}
          AND e.active
        ORDER BY d.next_attempt_at
        LIMIT ${options.limit ?? 50}`,
  );

  for (const delivery of due) {
    report.attempted += 1;

    // El `eventId` se agrega acá y no al encolar porque el producto lo usa para
    // deduplicar: tiene que ser el mismo en todos los reintentos de esta entrega.
    const body = JSON.stringify({ eventId: delivery.event_id, ...delivery.payload });
    const timestamp = Math.floor(now.getTime() / 1000);

    let status: number | null = null;
    let error: string | null = null;

    try {
      const response = await fetchImpl(delivery.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sophos-signature": signPayload(body, delivery.secret, timestamp),
          "x-sophos-event-type": delivery.event_type,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = response.status;
      if (!response.ok) error = `HTTP ${response.status}`;
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }

    const attempts = delivery.attempts + 1;

    if (!error) {
      await rows(
        db.drizzle,
        sql`UPDATE webhook_delivery
            SET status = 'delivered', attempts = ${attempts}, response_status = ${status},
                delivered_at = ${now.toISOString()}, last_error = NULL
            WHERE id = ${delivery.id}`,
      );
      report.delivered += 1;
      continue;
    }

    if (attempts >= MAX_ATTEMPTS) {
      // Se agota, no se borra: el comercio tiene derecho a saber qué avisos
      // nunca llegaron cuando pregunte por qué su POS no mostró un beneficio.
      await rows(
        db.drizzle,
        sql`UPDATE webhook_delivery
            SET status = 'exhausted', attempts = ${attempts},
                response_status = ${status}, last_error = ${error}
            WHERE id = ${delivery.id}`,
      );
      report.exhausted += 1;
      continue;
    }

    const waitMinutes = BACKOFF_MINUTES[attempts] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1]!;
    await rows(
      db.drizzle,
      sql`UPDATE webhook_delivery
          SET attempts = ${attempts}, response_status = ${status}, last_error = ${error},
              next_attempt_at = ${new Date(now.getTime() + waitMinutes * 60_000).toISOString()}
          WHERE id = ${delivery.id}`,
    );
    report.failed += 1;
  }

  return report;
}

/**
 * Beneficios que pasaron a estar disponibles con este movimiento.
 *
 * Solo los que **cruzaron el umbral ahora**: si el cliente ya podía canjear un
 * café antes de esta compra, no se avisa de nuevo. Repetir el aviso en cada
 * consumo lo volvería ruido y el cajero dejaría de mirarlo.
 */
export async function rewardsJustUnlocked(
  db: Db,
  merchantId: string,
  previousBalance: number,
  newBalance: number,
): Promise<{ id: string; name: string; cost: number }[]> {
  if (newBalance <= previousBalance) return [];

  return rows<{ id: string; name: string; cost: number }>(
    db.drizzle,
    sql`SELECT id, name, cost FROM reward
        WHERE merchant_id = ${merchantId} AND status = 'active'
          AND cost > ${previousBalance} AND cost <= ${newBalance}
        ORDER BY cost`,
  );
}
