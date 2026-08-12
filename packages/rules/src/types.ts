/**
 * Tipos del motor de reglas.
 *
 * El motor es declarativo a propósito: el comercio configura, no programa. Estas
 * primitivas cubren gastronomía (sellos por visita, puntos por consumo) y vida
 * nocturna (puntos por entrada, multiplicador por horario) sin una línea de
 * código por cliente. Resistir la tentación de volverlo Turing-completo.
 */

/** Eventos de negocio que emiten los productos del ecosistema. */
export type EventType =
  | "order.paid"
  | "ticket.validated"
  | "table.reserved"
  | "invoice.issued";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Condición para que una regla aplique. Todas las claves presentes deben cumplirse. */
export interface Condition {
  /** Días de la semana, evaluados en el huso del programa. */
  weekday?: Weekday[];
  /** Horas 0–23, evaluadas en el huso del programa. */
  hour?: number[];
}

/**
 * Regla de acumulación.
 *
 * Hay dos familias y no se mezclan en una misma regla:
 * - **Base** — define cuánto se gana: `points` (fijo) o `rate` (proporcional al monto).
 * - **Multiplicador** — `multiplier`, escala lo que las reglas base ya calcularon.
 */
export interface EarnRule {
  on: EventType;
  /** Cantidad fija a acumular cuando la regla aplica. */
  points?: number;
  /**
   * Alias de `points` para programas de sellos. Es el mismo concepto: se acepta
   * el otro nombre solo para que la config se lea natural en cada tipo de
   * programa. Si vinieran los dos, se suman.
   */
  stamps?: number;
  /** Acumulación proporcional: `points` por cada `per` unidades de monto. */
  rate?: { per: number; points: number };
  /** Escala el subtotal de las reglas base. Ver `evaluateEarn` para cómo se combinan. */
  multiplier?: number;
  /** Monto mínimo de la transacción para que la regla aplique. */
  minTotal?: number;
  when?: Condition;
}

export interface Tier {
  name: string;
  /** Saldo mínimo para alcanzar el nivel. */
  min: number;
}

export interface Caps {
  /** Tope de acumulación por evento individual. */
  perEvent?: number;
  /** Tope de acumulación por día de negocio. Ver `dayBoundaryHour`. */
  perDay?: number;
}

interface BaseConfig {
  earn: EarnRule[];
  caps?: Caps;
  expiry?: { months: number };
  /**
   * Huso horario del comercio. Define en qué día y hora cae un evento para
   * `when` y para el tope diario. Sin esto, un happy hour de jueves 18–20 en
   * Asunción se evaluaría en UTC y aplicaría en el horario equivocado.
   */
  timezone?: string;
  /**
   * Hora a la que empieza el día de negocio, 0–23. Un bar que cierra a las 4 AM
   * necesita `6`: así un consumo de la 1 AM del sábado cuenta como parte del
   * viernes, que es la noche que el cliente y el comercio consideran una sola.
   * Afecta al tope diario y a la agrupación por día.
   */
  dayBoundaryHour?: number;
  /** Preferencias de notificación. Las lee el despachador, no el motor. */
  notifications?: NotificationSettings;
}

export interface NotificationSettings {
  /**
   * Franja en la que no se manda nada, en horas locales del programa.
   * `{ from: 22, to: 9 }` significa desde las 22 hasta las 9 del día siguiente.
   *
   * **Es configurable por programa a propósito.** Para un restaurante el horario
   * inútil es la madrugada; para un boliche la madrugada es justamente cuando
   * tiene sentido escribir. Con una sola política fija, uno de los dos verticales
   * queda roto.
   */
  quietHours?: { from: number; to: number };
  /**
   * Minutos que se espera antes de mandar un aviso de saldo, agrupando lo que
   * pase en el medio. Tres consumos en la misma noche mandan un solo aviso con
   * el saldo final. Por defecto 15.
   */
  coalesceMinutes?: number;
  /** Avisos automáticos que el comercio apagó. */
  disabledKinds?: string[];
}

export interface PointsConfig extends BaseConfig {
  kind: "points";
  tiers?: Tier[];
}

export interface StampsConfig extends BaseConfig {
  kind: "stamps";
  /** Cantidad de sellos que desbloquea el beneficio. */
  rewardAt: number;
}

export type ProgramConfig = PointsConfig | StampsConfig;

/** Evento de negocio ya normalizado, listo para evaluar. */
export interface LoyaltyEvent {
  type: EventType;
  occurredAt: Date;
  /**
   * Monto de la transacción en la unidad mínima de la moneda. Para guaraníes es
   * el guaraní entero (PYG no usa decimales en la práctica). `rate.per` y
   * `minTotal` se expresan en la misma unidad.
   */
  amount?: number;
}

/** Estado de la membresía que el motor necesita para aplicar topes y niveles. */
export interface EarnContext {
  /** Ya acumulado en el día de negocio en curso, para el tope diario. */
  earnedToday: number;
  /** Saldo actual, para resolver el nivel resultante. */
  currentBalance: number;
}

/**
 * Traza de la evaluación. Existe para poder explicarle a un comercio por qué su
 * cliente recibió exactamente N puntos, que es la pregunta que aparece apenas
 * hay una disputa.
 */
export interface EarnTrace {
  /** Subtotal de las reglas base, antes de multiplicar. */
  base: number;
  /** Multiplicador efectivo aplicado. */
  multiplier: number;
  /** Resultado tras multiplicar, antes de topes. */
  afterMultiplier: number;
  /** Qué tope recortó el resultado, si alguno. */
  cappedBy: "per_event" | "per_day" | null;
  /** Índices de las reglas de `config.earn` que aplicaron. */
  matchedRules: number[];
  /** Día de negocio al que se imputa, en formato YYYY-MM-DD. */
  businessDay: string;
}

export interface EarnResult {
  amount: number;
  unit: "points" | "stamps";
  trace: EarnTrace;
}
