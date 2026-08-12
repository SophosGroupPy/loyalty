/**
 * Helpers de huso horario, sin dependencias: `Intl.DateTimeFormat` ya resuelve
 * husos con reglas de horario de verano, así que no hace falta traer una
 * librería de fechas para esto.
 */

import type { Weekday } from "./types.js";

/** Huso por defecto del ecosistema. */
export const DEFAULT_TIMEZONE = "America/Asuncion";

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: Weekday;
}

/** Descompone un instante en sus partes de calendario dentro de un huso dado. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    weekday: "short",
  }).formatToParts(date);

  const get = (type: string): string => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`No se pudo extraer "${type}" en el huso ${timeZone}`);
    return found.value;
  };

  // `hour12: false` devuelve 24 en vez de 0 para la medianoche en algunos ICU.
  const hour = Number(get("hour")) % 24;

  const shortWeekday = get("weekday").toLowerCase().slice(0, 3);
  const weekday = WEEKDAYS.find((d) => d === shortWeekday);
  if (!weekday) throw new Error(`Día de la semana inesperado: ${shortWeekday}`);

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    weekday,
  };
}

/**
 * Día de negocio al que pertenece un instante, como YYYY-MM-DD.
 *
 * Con `dayBoundaryHour = 6`, todo lo que ocurre entre medianoche y las 6 AM se
 * imputa al día anterior. Es lo que hace que una noche de boliche que cruza las
 * 12 cuente como una sola jornada y no como dos.
 */
export function businessDay(
  date: Date,
  timeZone: string,
  dayBoundaryHour = 0,
): string {
  const { hour } = zonedParts(date, timeZone);

  const shifted =
    hour < dayBoundaryHour
      ? new Date(date.getTime() - 24 * 60 * 60 * 1000)
      : date;

  const p = zonedParts(shifted, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
