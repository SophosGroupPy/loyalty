import { DEFAULT_TIMEZONE, businessDay, zonedParts } from "./time.js";
import type {
  EarnContext,
  EarnResult,
  EarnRule,
  LoyaltyEvent,
  ProgramConfig,
  Tier,
} from "./types.js";

/**
 * Cantidad que aporta una regla base, sin importar el `kind` del programa.
 *
 * Se aceptan dos nombres para el mismo concepto porque cada uno se lee natural
 * en su tipo de programa: `points` en uno de puntos, `stamps` en uno de sellos.
 * Internamente es un solo número.
 */
function fixedAmount(rule: EarnRule): number {
  return (rule.points ?? 0) + (rule.stamps ?? 0);
}

/** ¿La regla aplica a este evento? */
function matches(
  rule: EarnRule,
  event: LoyaltyEvent,
  timezone: string,
): boolean {
  if (rule.on !== event.type) return false;

  if (rule.minTotal !== undefined) {
    // Sin monto no se puede comprobar un mínimo: la regla no aplica, en vez de
    // aplicar por omisión. Acumular de más es mucho más caro de revertir.
    if (event.amount === undefined) return false;
    if (event.amount < rule.minTotal) return false;
  }

  const when = rule.when;
  if (!when) return true;

  const { weekday, hour } = zonedParts(event.occurredAt, timezone);
  if (when.weekday && !when.weekday.includes(weekday)) return false;
  if (when.hour && !when.hour.includes(hour)) return false;

  return true;
}

/**
 * Evalúa cuánto acumula una membresía por un evento.
 *
 * El orden es: reglas base → multiplicador → tope por evento → tope diario.
 *
 * **Los multiplicadores no se acumulan entre sí: se aplica el mayor.** Si un
 * comercio configura "jueves x2" y "cumpleaños x3" y ambos caen el mismo día, el
 * cliente recibe x3, no x6. Multiplicar entre ellos convertiría dos promociones
 * razonables en un pasivo de puntos que el comercio no dimensionó.
 *
 * Todo redondeo es hacia abajo, tanto en `rate` como al multiplicar.
 */
export function evaluateEarn(
  config: ProgramConfig,
  event: LoyaltyEvent,
  context: EarnContext,
): EarnResult {
  const timezone = config.timezone ?? DEFAULT_TIMEZONE;
  const unit = config.kind === "stamps" ? "stamps" : "points";

  const matchedRules: number[] = [];
  let base = 0;
  let multiplier = 1;

  config.earn.forEach((rule, index) => {
    if (!matches(rule, event, timezone)) return;
    matchedRules.push(index);

    base += fixedAmount(rule);

    if (rule.rate && rule.rate.per > 0 && event.amount !== undefined) {
      base += Math.floor(event.amount / rule.rate.per) * rule.rate.points;
    }

    if (rule.multiplier !== undefined && rule.multiplier > 0) {
      multiplier = Math.max(multiplier, rule.multiplier);
    }
  });

  // Multiplicador del nivel del cliente, según el saldo con el que llega al
  // evento —no el resultante. Se combina con el de horario multiplicándose: un
  // cliente Oro (2x) en el happy hour (2x) suma 4x. Es una decisión de diseño y
  // no un accidente: son dos incentivos distintos —lealtad y franja— y sumarlos
  // o quedarse con el mayor le sacaría sentido a combinar los dos.
  const nivel = tierFor(config, context.currentBalance);
  const tierMultiplier = nivel?.multiplier && nivel.multiplier > 0 ? nivel.multiplier : 1;

  const afterMultiplier = Math.floor(base * multiplier * tierMultiplier);

  let amount = afterMultiplier;
  let cappedBy: EarnResult["trace"]["cappedBy"] = null;

  const perEvent = config.caps?.perEvent;
  if (perEvent !== undefined && amount > perEvent) {
    amount = perEvent;
    cappedBy = "per_event";
  }

  const perDay = config.caps?.perDay;
  if (perDay !== undefined) {
    const remaining = Math.max(0, perDay - context.earnedToday);
    if (amount > remaining) {
      amount = remaining;
      cappedBy = "per_day";
    }
  }

  return {
    amount,
    unit,
    trace: {
      base,
      multiplier: multiplier * tierMultiplier,
      tierMultiplier,
      afterMultiplier,
      cappedBy,
      matchedRules,
      businessDay: businessDay(
        event.occurredAt,
        timezone,
        config.dayBoundaryHour ?? 0,
      ),
    },
  };
}

/**
 * Nivel que corresponde a un saldo. Devuelve `null` si el programa no usa
 * niveles o si el saldo no alcanza el primero.
 */
export function tierFor(config: ProgramConfig, balance: number): Tier | null {
  if (config.kind !== "points" || !config.tiers?.length) return null;

  return (
    [...config.tiers]
      .sort((a, b) => b.min - a.min)
      .find((tier) => balance >= tier.min) ?? null
  );
}

/**
 * Cuántos beneficios completos tiene disponibles una tarjeta de sellos, y
 * cuántos sellos faltan para el siguiente.
 */
export function stampProgress(
  config: ProgramConfig,
  stamps: number,
): { available: number; toNext: number } {
  if (config.kind !== "stamps" || config.rewardAt <= 0) {
    return { available: 0, toNext: 0 };
  }

  return {
    available: Math.floor(stamps / config.rewardAt),
    toNext: config.rewardAt - (stamps % config.rewardAt),
  };
}

/**
 * Valida una configuración antes de guardarla. Se ejecuta cuando el comercio
 * guarda desde la consola: es mucho más barato rechazar acá que descubrir el
 * problema cuando ya emitió mil tarjetas.
 */
export function validateConfig(config: ProgramConfig): string[] {
  const errors: string[] = [];

  if (!config.earn?.length) {
    errors.push("El programa necesita al menos una regla de acumulación.");
  }

  config.earn?.forEach((rule, i) => {
    const prefix = `earn[${i}]`;

    if (rule.rate && rule.rate.per <= 0) {
      errors.push(`${prefix}: rate.per tiene que ser mayor a cero.`);
    }
    if (rule.multiplier !== undefined && rule.multiplier <= 0) {
      errors.push(`${prefix}: multiplier tiene que ser mayor a cero.`);
    }
    if (
      fixedAmount(rule) === 0 &&
      !rule.rate &&
      rule.multiplier === undefined
    ) {
      errors.push(`${prefix}: la regla no acumula nada ni multiplica.`);
    }
    rule.when?.hour?.forEach((h) => {
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        errors.push(`${prefix}: hora fuera de rango (${h}).`);
      }
    });
  });

  if (config.kind === "stamps" && config.rewardAt <= 0) {
    errors.push("rewardAt tiene que ser mayor a cero.");
  }

  const boundary = config.dayBoundaryHour;
  if (
    boundary !== undefined &&
    (!Number.isInteger(boundary) || boundary < 0 || boundary > 23)
  ) {
    errors.push("dayBoundaryHour tiene que ser un entero entre 0 y 23.");
  }

  if (config.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: config.timezone });
    } catch {
      errors.push(`Huso horario desconocido: ${config.timezone}`);
    }
  }

  if (config.kind === "points" && config.tiers) {
    const names = new Set<string>();
    const minimos = new Set<number>();
    for (const tier of config.tiers) {
      if (!tier.name.trim()) errors.push("Un nivel no puede tener nombre vacío.");
      if (names.has(tier.name)) errors.push(`Nivel duplicado: ${tier.name}`);
      names.add(tier.name);

      if (!Number.isInteger(tier.min) || tier.min < 0) {
        errors.push(`El nivel ${tier.name} necesita un mínimo entero y no negativo.`);
      }
      // Dos niveles con el mismo umbral son indistinguibles: uno nunca se
      // alcanza. Es un error de configuración, no una preferencia.
      if (minimos.has(tier.min)) errors.push(`Dos niveles arrancan en ${tier.min}.`);
      minimos.add(tier.min);

      if (tier.multiplier !== undefined && !(tier.multiplier > 0)) {
        errors.push(`El multiplicador del nivel ${tier.name} tiene que ser mayor a cero.`);
      }
    }
  }

  return errors;
}
