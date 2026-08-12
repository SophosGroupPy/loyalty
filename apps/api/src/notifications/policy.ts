/**
 * Las reglas del despachador, separadas de la base de datos para poder probarlas
 * como funciones puras.
 *
 * El problema que resuelven: cada notificación compite por un recurso escaso.
 * Google acepta 3 por pase cada 24 h y WhatsApp cobra por mensaje. Mandar todo
 * lo que pasa no es una opción, así que hay que decidir qué se manda y qué se
 * descarta — y esa decisión tiene que ser explicable después.
 */

import { zonedParts, type NotificationSettings } from "@sophos/rules";

export type NotificationKind =
  | "balance_changed"
  | "points_expiring"
  | "reward_unlocked"
  | "tier_changed"
  | "campaign";

export type Channel = "wallet" | "whatsapp" | "webpush";

/**
 * Prioridad de cada tipo. **Menor gana.**
 *
 * El orden no es arbitrario:
 * - `balance_changed` es transaccional: el cliente acaba de consumir y espera
 *   verlo reflejado. Si no llega, el programa parece roto.
 * - `points_expiring` va segundo porque tiene fecha límite: suprimirlo le
 *   cuesta puntos reales al cliente y termina en un reclamo.
 * - `reward_unlocked` y `tier_changed` son valiosos pero pueden esperar un día.
 * - `campaign` va última: es lo único que el comercio puede reprogramar.
 */
export const PRIORITY: Record<NotificationKind, number> = {
  balance_changed: 1,
  points_expiring: 2,
  reward_unlocked: 3,
  tier_changed: 4,
  campaign: 5,
};

/** Cupo de Google por pase cada 24 h. Se replica acá en vez de esperar su rechazo. */
export const DAILY_BUDGET = 3;

/**
 * Cupo efectivo de las campañas: uno menos que el total.
 *
 * Reserva un lugar para lo transaccional. Sin esta reserva, una campaña mandada
 * a la mañana podría consumir el último cupo y dejar sin aviso a un cliente que
 * consume a la noche — y una notificación ya enviada no se puede devolver. La
 * prioridad sola no alcanza, porque solo ordena lo que está pendiente al mismo
 * tiempo.
 */
export const CAMPAIGN_BUDGET = DAILY_BUDGET - 1;

export const DEFAULT_COALESCE_MINUTES = 15;

/** Cuánto cupo puede consumir un tipo de aviso. */
export function budgetFor(kind: NotificationKind): number {
  return kind === "campaign" ? CAMPAIGN_BUDGET : DAILY_BUDGET;
}

/**
 * Clave de agrupación.
 *
 * Todos los avisos de saldo de una misma tarjeta comparten clave, así que tres
 * consumos seguidos producen un solo envío. Las campañas se agrupan por campaña:
 * el mismo cliente no recibe dos veces el mismo mensaje, pero sí puede recibir
 * dos campañas distintas.
 */
export function dedupeKeyFor(kind: NotificationKind, reference?: string): string {
  return kind === "campaign" && reference ? `campaign:${reference}` : kind;
}

/**
 * ¿Está dentro de la franja de silencio?
 *
 * Soporta franjas que cruzan la medianoche (`from: 22, to: 9`), que es el caso
 * normal, y también las que no (`from: 6, to: 18`, típico de un boliche).
 */
export function isQuietHour(hour: number, quiet: { from: number; to: number }): boolean {
  if (quiet.from === quiet.to) return false;
  return quiet.from < quiet.to
    ? hour >= quiet.from && hour < quiet.to
    : hour >= quiet.from || hour < quiet.to;
}

/**
 * Corre un envío hasta el final de la franja de silencio.
 *
 * Se reprograma en vez de descartar: el aviso sigue siendo útil más tarde, y
 * perderlo por haber caído a la hora equivocada sería peor que demorarlo.
 */
export function nextAllowedTime(
  at: Date,
  timezone: string,
  settings: NotificationSettings | undefined,
): Date {
  const quiet = settings?.quietHours;
  if (!quiet) return at;

  let candidate = at;
  // Como máximo 24 saltos de una hora: si en un día entero no hay ninguna hora
  // permitida, la configuración silencia todo y se manda igual antes que
  // acumular avisos para siempre.
  for (let i = 0; i < 24; i++) {
    const { hour } = zonedParts(candidate, timezone);
    if (!isQuietHour(hour, quiet)) return candidate;

    // Salta al comienzo de la próxima hora en punto, no a "una hora después".
    const next = new Date(candidate.getTime() + 60 * 60 * 1000);
    next.setUTCMinutes(0, 0, 0);
    candidate = next;
  }

  return at;
}

/** Momento en que debería salir un aviso recién encolado. */
export function scheduleFor(
  kind: NotificationKind,
  now: Date,
  timezone: string,
  settings: NotificationSettings | undefined,
): Date {
  const delayMinutes =
    kind === "balance_changed"
      ? (settings?.coalesceMinutes ?? DEFAULT_COALESCE_MINUTES)
      : 0;

  const at = new Date(now.getTime() + delayMinutes * 60 * 1000);
  return nextAllowedTime(at, timezone, settings);
}

/** ¿El comercio apagó este tipo de aviso automático? */
export function isKindEnabled(
  kind: NotificationKind,
  settings: NotificationSettings | undefined,
): boolean {
  return !settings?.disabledKinds?.includes(kind);
}
