import { describe, expect, it } from "vitest";

import { mesYAnio } from "./format.js";

describe("mesYAnio", () => {
  it("formatea en castellano", () => {
    expect(mesYAnio("2021-08-15")).toBe("agosto 2021");
    expect(mesYAnio("2026-01-02")).toBe("enero 2026");
  });

  it("lee la fecha en UTC, no en el huso del servidor", () => {
    // Un alta a las 23:30 de Asunción (UTC-3) es 02:30 UTC del día siguiente.
    // Leerla en local la correría un día, y en fin de mes, un mes.
    expect(mesYAnio("2026-01-31T23:30:00-03:00")).toBe("febrero 2026");
  });

  it("devuelve null ante una fecha que no se entiende", () => {
    expect(mesYAnio("no es fecha")).toBeNull();
    expect(mesYAnio("")).toBeNull();
  });
});
