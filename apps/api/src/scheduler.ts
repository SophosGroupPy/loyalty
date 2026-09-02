/**
 * Trabajos periódicos, con la frecuencia siguiendo a la actividad.
 *
 * Los webhooks y las notificaciones **se encolan y salen recién cuando corre el
 * despachador**. Con un intervalo fijo de una hora, el POS se enteraría una hora
 * tarde de que el cliente tiene un beneficio disponible, que es justo el momento
 * en que se canjea. Pero consultar la cola cada minuto las 24 horas mantiene
 * despierta la base y agota el cómputo del plan de Neon a mitad de mes.
 *
 * La salida es que el costo real solo existe **cuando la base está dormida**:
 * con tráfico ya está despierta y una consulta más no cambia nada. Entonces:
 *
 * - Hubo actividad hace poco → se revisa la cola cada minuto.
 * - No hubo → se espera una hora antes de tocar la base, y mientras tanto puede
 *   dormir.
 *
 * Con eso la latencia es de un minuto cuando importa —que es cuando hay gente
 * consumiendo— y de una hora cuando no hay nadie a quien avisarle.
 */

import { hostname } from "node:os";

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";

export interface Job {
  name: string;
  run(): Promise<unknown>;
}

export interface SchedulerOptions {
  /** Cada cuánto se revisa, con actividad reciente. */
  activeIntervalMs?: number;
  /** Cada cuánto, sin actividad: acá es donde se le deja dormir a la base. */
  idleIntervalMs?: number;
  /** Cuánto se considera "actividad reciente". */
  activityWindowMs?: number;
  now?: () => number;
  onError?: (job: string, error: unknown) => void;
}

export interface Scheduler {
  /** La marca de que hubo tráfico. La llama el servidor en cada request. */
  markActivity(): void;
  /** Corre una vuelta. Devuelve los trabajos que efectivamente ejecutó. */
  tick(): Promise<string[]>;
  start(): void;
  stop(): void;
}

const MINUTO = 60_000;

export function createScheduler(db: Db, jobs: Job[], opts: SchedulerOptions = {}): Scheduler {
  const activo = opts.activeIntervalMs ?? MINUTO;
  const ocioso = opts.idleIntervalMs ?? 60 * MINUTO;
  const ventana = opts.activityWindowMs ?? 5 * MINUTO;
  const ahora = opts.now ?? Date.now;
  const host = hostname();

  let ultimaActividad = 0;
  let ultimoIntento = 0;
  let timer: NodeJS.Timeout | null = null;

  /**
   * Reclama el trabajo con un UPDATE condicional.
   *
   * Es atómico: si dos máquinas lo intentan a la vez, solo una ve la fila vieja
   * y solo una devuelve resultado. El intervalo mínimo va en el WHERE, así que
   * la coordinación y el ritmo se resuelven en la misma operación.
   */
  async function reclamar(job: string, intervaloMs: number): Promise<boolean> {
    const tomado = await rows<{ name: string }>(
      db.drizzle,
      sql`INSERT INTO job_run (name, last_run_at, last_host)
          VALUES (${job}, now(), ${host})
          ON CONFLICT (name) DO UPDATE
            SET last_run_at = now(), last_host = ${host}
            WHERE job_run.last_run_at < now() - ${`${Math.round(intervaloMs / 1000)} seconds`}::interval
          RETURNING name`,
    );
    return tomado.length > 0;
  }

  async function anotar(job: string, resultado: unknown): Promise<void> {
    await rows(
      db.drizzle,
      sql`UPDATE job_run SET last_result = ${JSON.stringify(resultado ?? null)}::jsonb
          WHERE name = ${job}`,
    );
  }

  return {
    markActivity() {
      ultimaActividad = ahora();
    },

    async tick() {
      const t = ahora();
      const conTrafico = t - ultimaActividad < ventana;
      const intervalo = conTrafico ? activo : ocioso;

      // Sin tráfico, no se toca la base hasta que pase el intervalo largo. Es
      // la única forma de que duerma: cualquier consulta la despierta cinco
      // minutos, y una consulta por minuto la mantiene despierta para siempre.
      if (!conTrafico && t - ultimoIntento < ocioso) return [];
      ultimoIntento = t;

      const corridos: string[] = [];
      for (const job of jobs) {
        try {
          if (!(await reclamar(job.name, intervalo))) continue;
          await anotar(job.name, await job.run());
          corridos.push(job.name);
        } catch (error) {
          // Un trabajo que falla no puede llevarse puestos a los demás: la cola
          // de webhooks no tiene nada que ver con el vencimiento de puntos.
          opts.onError?.(job.name, error);
        }
      }
      return corridos;
    },

    start() {
      if (timer) return;
      // `unref` para que un trabajo pendiente no impida que el proceso cierre
      // cuando Fly manda la señal de apagado.
      timer = setInterval(() => void this.tick(), activo);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
