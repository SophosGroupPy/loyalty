/**
 * Trabajos periódicos.
 *
 * Lo que se prueba es el ritmo, no que los trabajos hagan su tarea —de eso se
 * encargan sus propios tests. Acá importa que la base pueda dormir cuando no
 * hay nadie, y que la cola se revise seguido cuando sí.
 */

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { createScheduler, type Job } from "./scheduler.js";

let db: Db;
let reloj = 1_000_000;

const avanzar = (ms: number) => (reloj += ms);

function contador(name: string): Job & { veces: number } {
  const job = { name, veces: 0, run: async () => ({ ok: ++job.veces }) };
  return job;
}

beforeEach(async () => {
  db = await createTestDb();
  reloj = 1_000_000;
});

afterEach(async () => {
  await db.close();
});

const armar = (jobs: Job[]) =>
  createScheduler(db, jobs, {
    activeIntervalMs: 60_000,
    idleIntervalMs: 3_600_000,
    activityWindowMs: 5 * 60_000,
    now: () => reloj,
  });

// ---------------------------------------------------------------------------

describe("ritmo con tráfico", () => {
  it("revisa la cola cada minuto", async () => {
    const job = contador("notifications");
    const s = armar([job]);

    s.markActivity();
    expect(await s.tick()).toEqual(["notifications"]);

    // Antes del minuto no corre de nuevo.
    avanzar(30_000);
    s.markActivity();
    expect(await s.tick()).toEqual([]);

    avanzar(31_000);
    s.markActivity();
    expect(await s.tick()).toEqual(["notifications"]);
    expect(job.veces).toBe(2);
  });
});

describe("ritmo sin tráfico", () => {
  it("no toca la base hasta que pase la hora", async () => {
    // Es lo único que le permite dormir a la base: cualquier consulta la
    // despierta cinco minutos, y una por minuto la mantiene despierta siempre.
    const job = contador("webhooks");
    const s = armar([job]);

    s.markActivity();
    await s.tick();

    avanzar(10 * 60_000); // pasó la ventana de actividad
    for (let i = 0; i < 20; i++) {
      expect(await s.tick()).toEqual([]);
      avanzar(60_000);
    }
    expect(job.veces).toBe(1);
  });

  it("corre una vez pasada la hora", async () => {
    const job = contador("expiry");
    const s = armar([job]);

    s.markActivity();
    await s.tick();

    avanzar(3_601_000);
    expect(await s.tick()).toEqual(["expiry"]);
    expect(job.veces).toBe(2);
  });

  it("volver a haber tráfico acelera de nuevo", async () => {
    const job = contador("notifications");
    const s = armar([job]);

    s.markActivity();
    await s.tick();

    avanzar(10 * 60_000);
    expect(await s.tick()).toEqual([]); // dormida

    avanzar(60_000);
    s.markActivity(); // entró alguien
    expect(await s.tick()).toEqual(["notifications"]);
  });
});

describe("dos máquinas a la vez", () => {
  it("solo una toma el trabajo", async () => {
    // Durante un deploy conviven dos máquinas unos segundos. Sin el reclamo,
    // las dos despacharían la misma cola.
    const a = contador("notifications");
    const b = contador("notifications");
    const uno = armar([a]);
    const otro = armar([b]);

    uno.markActivity();
    otro.markActivity();

    const [r1, r2] = await Promise.all([uno.tick(), otro.tick()]);

    expect([...r1, ...r2]).toEqual(["notifications"]);
    expect(a.veces + b.veces).toBe(1);
  });
});

describe("cuando un trabajo falla", () => {
  it("no se lleva puestos a los demás", async () => {
    // La cola de webhooks no tiene nada que ver con el vencimiento de puntos.
    const errores: string[] = [];
    const bueno = contador("expiry");
    const roto: Job = { name: "webhooks", run: async () => { throw new Error("sin red"); } };

    const s = createScheduler(db, [roto, bueno], {
      activeIntervalMs: 60_000,
      now: () => reloj,
      onError: (job) => errores.push(job),
    });

    s.markActivity();
    expect(await s.tick()).toEqual(["expiry"]);
    expect(errores).toEqual(["webhooks"]);
  });
});

describe("rastro para diagnosticar", () => {
  it("deja anotado cuándo corrió y con qué resultado", async () => {
    // Un trabajo que dejó de correr no avisa: se nota cuando alguien pregunta
    // por qué no llegó una notificación.
    const s = armar([contador("notifications")]);
    s.markActivity();
    await s.tick();

    const [fila] = await rows<{ name: string; last_host: string; last_result: unknown }>(
      db.drizzle,
      sql`SELECT name, last_host, last_result FROM job_run WHERE name = 'notifications'`,
    );
    expect(fila!.last_host).toBeTruthy();
    expect(fila!.last_result).toEqual({ ok: 1 });
  });
});
