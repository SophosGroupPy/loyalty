import { describe, expect, it } from "vitest";

import {
  evaluateEarn,
  stampProgress,
  tierFor,
  validateConfig,
} from "./evaluate.js";
import { businessDay } from "./time.js";
import type { EarnContext, PointsConfig, StampsConfig } from "./types.js";

/**
 * Paraguay está en UTC-3 todo el año (no usa horario de verano), así que estos
 * instantes son estables:
 *   2026-08-13T22:30:00Z → jueves 19:30 en Asunción
 *   2026-08-15T04:30:00Z → sábado  01:30 en Asunción
 */
const JUEVES_19_30 = new Date("2026-08-13T22:30:00Z");
const SABADO_01_30 = new Date("2026-08-15T04:30:00Z");

const FRESH: EarnContext = { earnedToday: 0, currentBalance: 0 };

/** Programa tipo ElMenu: 1 punto cada 10.000 Gs. */
const elmenu: PointsConfig = {
  kind: "points",
  earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }],
};

describe("acumulación base", () => {
  it("redondea hacia abajo la acumulación proporcional", () => {
    const r = evaluateEarn(
      elmenu,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 35_000 },
      FRESH,
    );
    expect(r.amount).toBe(3);
    expect(r.unit).toBe("points");
  });

  it("no acumula nada por debajo de la primera unidad", () => {
    const r = evaluateEarn(
      elmenu,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 9_999 },
      FRESH,
    );
    expect(r.amount).toBe(0);
  });

  it("ignora los eventos de otro tipo", () => {
    const r = evaluateEarn(
      elmenu,
      { type: "ticket.validated", occurredAt: JUEVES_19_30 },
      FRESH,
    );
    expect(r.amount).toBe(0);
    expect(r.trace.matchedRules).toEqual([]);
  });

  it("suma varias reglas base que aplican al mismo evento", () => {
    const config: PointsConfig = {
      kind: "points",
      earn: [
        { on: "order.paid", points: 5 },
        { on: "order.paid", rate: { per: 10_000, points: 1 } },
      ],
    };
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 30_000 },
      FRESH,
    );
    expect(r.amount).toBe(8);
    expect(r.trace.matchedRules).toEqual([0, 1]);
  });
});

describe("multiplicadores y horario", () => {
  const conHappyHour: PointsConfig = {
    kind: "points",
    earn: [
      { on: "order.paid", rate: { per: 10_000, points: 1 } },
      { on: "order.paid", multiplier: 2, when: { weekday: ["thu"], hour: [19] } },
    ],
  };

  it("aplica el multiplicador dentro de la ventana, en huso local", () => {
    const r = evaluateEarn(
      conHappyHour,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 30_000 },
      FRESH,
    );
    expect(r.trace.base).toBe(3);
    expect(r.trace.multiplier).toBe(2);
    expect(r.amount).toBe(6);
  });

  it("no aplica el multiplicador fuera de la ventana", () => {
    const r = evaluateEarn(
      conHappyHour,
      { type: "order.paid", occurredAt: SABADO_01_30, amount: 30_000 },
      FRESH,
    );
    expect(r.trace.multiplier).toBe(1);
    expect(r.amount).toBe(3);
  });

  it("toma el multiplicador mayor y NO los acumula entre sí", () => {
    // Dos promos que caen el mismo momento. x2 y x3 tienen que dar x3, nunca x6:
    // multiplicarlos convertiría dos promos razonables en un pasivo que el
    // comercio no dimensionó.
    const config: PointsConfig = {
      kind: "points",
      earn: [
        { on: "order.paid", rate: { per: 10_000, points: 1 } },
        { on: "order.paid", multiplier: 2, when: { weekday: ["thu"] } },
        { on: "order.paid", multiplier: 3, when: { hour: [19] } },
      ],
    };
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 100_000 },
      FRESH,
    );
    expect(r.trace.base).toBe(10);
    expect(r.trace.multiplier).toBe(3);
    expect(r.amount).toBe(30);
  });

  it("redondea hacia abajo tras multiplicar", () => {
    const config: PointsConfig = {
      kind: "points",
      earn: [
        { on: "order.paid", points: 3 },
        { on: "order.paid", multiplier: 1.5 },
      ],
    };
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 1 },
      FRESH,
    );
    expect(r.amount).toBe(4);
  });
});

describe("minTotal", () => {
  const config: PointsConfig = {
    kind: "points",
    earn: [{ on: "order.paid", points: 1, minTotal: 25_000 }],
  };

  it("aplica cuando el monto alcanza el mínimo", () => {
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 25_000 },
      FRESH,
    );
    expect(r.amount).toBe(1);
  });

  it("no aplica por debajo del mínimo", () => {
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 24_999 },
      FRESH,
    );
    expect(r.amount).toBe(0);
  });

  it("no aplica si el evento no trae monto", () => {
    // Sin monto no se puede comprobar el mínimo. Se opta por no acumular:
    // devolver puntos de más es mucho más caro de revertir que de menos.
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30 },
      FRESH,
    );
    expect(r.amount).toBe(0);
  });
});

describe("topes", () => {
  const config: PointsConfig = {
    kind: "points",
    earn: [{ on: "order.paid", rate: { per: 1_000, points: 1 } }],
    caps: { perEvent: 50, perDay: 200 },
  };

  it("recorta por evento", () => {
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 500_000 },
      FRESH,
    );
    expect(r.amount).toBe(50);
    expect(r.trace.cappedBy).toBe("per_event");
    expect(r.trace.afterMultiplier).toBe(500);
  });

  it("recorta por día considerando lo ya acumulado", () => {
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 500_000 },
      { earnedToday: 180, currentBalance: 180 },
    );
    expect(r.amount).toBe(20);
    expect(r.trace.cappedBy).toBe("per_day");
  });

  it("devuelve cero con el tope diario agotado", () => {
    const r = evaluateEarn(
      config,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 500_000 },
      { earnedToday: 200, currentBalance: 200 },
    );
    expect(r.amount).toBe(0);
    expect(r.trace.cappedBy).toBe("per_day");
  });
});

describe("sellos", () => {
  const cafe: StampsConfig = {
    kind: "stamps",
    earn: [{ on: "order.paid", stamps: 1, minTotal: 25_000 }],
    rewardAt: 10,
  };

  it("da un sello por consumo que alcanza el mínimo", () => {
    const r = evaluateEarn(
      cafe,
      { type: "order.paid", occurredAt: JUEVES_19_30, amount: 30_000 },
      FRESH,
    );
    expect(r.amount).toBe(1);
    expect(r.unit).toBe("stamps");
  });

  it("calcula beneficios disponibles y cuántos faltan", () => {
    expect(stampProgress(cafe, 0)).toEqual({ available: 0, toNext: 10 });
    expect(stampProgress(cafe, 7)).toEqual({ available: 0, toNext: 3 });
    expect(stampProgress(cafe, 10)).toEqual({ available: 1, toNext: 10 });
    expect(stampProgress(cafe, 23)).toEqual({ available: 2, toNext: 7 });
  });
});

describe("niveles", () => {
  const config: PointsConfig = {
    kind: "points",
    earn: [{ on: "order.paid", points: 1 }],
    tiers: [
      { name: "Plata", min: 100 },
      { name: "Oro", min: 500 },
    ],
  };

  it("devuelve null por debajo del primer nivel", () => {
    expect(tierFor(config, 99)).toBeNull();
  });

  it("devuelve el nivel más alto alcanzado", () => {
    expect(tierFor(config, 100)?.name).toBe("Plata");
    expect(tierFor(config, 499)?.name).toBe("Plata");
    expect(tierFor(config, 500)?.name).toBe("Oro");
    expect(tierFor(config, 10_000)?.name).toBe("Oro");
  });
});

describe("multiplicador por nivel", () => {
  const config: PointsConfig = {
    kind: "points",
    earn: [{ on: "order.paid", rate: { per: 1000, points: 1 } }],
    tiers: [
      { name: "Plata", min: 100 }, // solo estatus, sin multiplicador
      { name: "Oro", min: 500, multiplier: 2 },
    ],
  };

  const evento = { type: "order.paid" as const, amount: 10_000, occurredAt: new Date("2026-09-03T15:00:00Z") };

  it("un nivel sin multiplicador no cambia lo que se suma", () => {
    // Plata es estatus puro: 10.000 / 1.000 = 10 puntos, sin boost.
    const r = evaluateEarn(config, evento, { earnedToday: 0, currentBalance: 200 });
    expect(r.amount).toBe(10);
    expect(r.trace.tierMultiplier).toBe(1);
  });

  it("un nivel con multiplicador acumula más, según el saldo con el que llega", () => {
    // Oro (2x): 10 × 2 = 20. El nivel sale del saldo previo, no del resultante.
    const r = evaluateEarn(config, evento, { earnedToday: 0, currentBalance: 600 });
    expect(r.amount).toBe(20);
    expect(r.trace.tierMultiplier).toBe(2);
  });

  it("el multiplicador de nivel y el de horario se multiplican entre sí", () => {
    const conHappyHour: PointsConfig = {
      ...config,
      earn: [
        { on: "order.paid", rate: { per: 1000, points: 1 } },
        { on: "order.paid", multiplier: 2, when: { hour: [15] } },
      ],
      timezone: "UTC",
    };
    // Oro (2x) en el happy hour (2x): 10 × 2 × 2 = 40.
    const r = evaluateEarn(conHappyHour, evento, { earnedToday: 0, currentBalance: 600 });
    expect(r.amount).toBe(40);
  });

  it("el tope se aplica después del multiplicador de nivel, no antes", () => {
    // Sin el tope, Oro daría 20. Con perEvent 15, el nivel no lo puede superar.
    const conTope: PointsConfig = { ...config, caps: { perEvent: 15 } };
    const r = evaluateEarn(conTope, evento, { earnedToday: 0, currentBalance: 600 });
    expect(r.amount).toBe(15);
    expect(r.trace.cappedBy).toBe("per_event");
  });
});

describe("día de negocio", () => {
  it("imputa la madrugada al día anterior cuando el corte es a las 6", () => {
    // Sábado 01:30 en Asunción, con corte a las 6: es todavía la noche del
    // viernes. Sin esto, una salida a un boliche se parte en dos días y el tope
    // diario se duplica sin que nadie lo haya decidido.
    expect(businessDay(SABADO_01_30, "America/Asuncion", 6)).toBe("2026-08-14");
  });

  it("sin corte, la medianoche ya cambia el día", () => {
    expect(businessDay(SABADO_01_30, "America/Asuncion", 0)).toBe("2026-08-15");
  });

  it("el huso cambia el día de negocio para el mismo instante", () => {
    expect(businessDay(SABADO_01_30, "UTC", 0)).toBe("2026-08-15");
    expect(businessDay(new Date("2026-08-15T02:00:00Z"), "America/Asuncion", 0)).toBe(
      "2026-08-14",
    );
  });
});

describe("validación de configuración", () => {
  it("acepta una config válida", () => {
    expect(validateConfig(elmenu)).toEqual([]);
  });

  it("rechaza un programa sin reglas", () => {
    const errors = validateConfig({ kind: "points", earn: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/al menos una regla/);
  });

  it("rechaza rate.per en cero, que dividiría por cero", () => {
    const errors = validateConfig({
      kind: "points",
      earn: [{ on: "order.paid", rate: { per: 0, points: 1 } }],
    });
    expect(errors.some((e) => e.includes("rate.per"))).toBe(true);
  });

  it("rechaza una regla que no acumula ni multiplica", () => {
    const errors = validateConfig({
      kind: "points",
      earn: [{ on: "order.paid" }],
    });
    expect(errors.some((e) => e.includes("no acumula nada"))).toBe(true);
  });

  it("rechaza horas y husos inválidos", () => {
    const errors = validateConfig({
      kind: "points",
      earn: [{ on: "order.paid", points: 1, when: { hour: [25] } }],
      timezone: "America/Nowhere",
    });
    expect(errors.some((e) => e.includes("hora fuera de rango"))).toBe(true);
    expect(errors.some((e) => e.includes("Huso horario desconocido"))).toBe(true);
  });

  it("rechaza sellos sin meta de canje", () => {
    const errors = validateConfig({
      kind: "stamps",
      earn: [{ on: "order.paid", stamps: 1 }],
      rewardAt: 0,
    });
    expect(errors.some((e) => e.includes("rewardAt"))).toBe(true);
  });
});
