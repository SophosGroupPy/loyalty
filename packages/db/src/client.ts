/**
 * Fábrica de conexiones.
 *
 * Dos drivers, un solo esquema:
 * - **PGlite** en desarrollo y en los tests — Postgres real compilado a WASM,
 *   corre en proceso. Sin servidor que levantar y cada test arranca limpio.
 * - **node-postgres** en producción, contra el Postgres de Fly.
 *
 * El SQL es el mismo en los dos casos, así que lo que pasa en los tests es lo
 * que va a pasar en producción.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sql, type SQL } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import { schema } from "./schema.js";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Db {
  drizzle: Database;
  /**
   * Ejecuta SQL y devuelve las filas.
   *
   * Existe porque `drizzle.execute()` no devuelve lo mismo en los dos drivers:
   * PGlite entrega `{rows, fields, affectedRows}` y node-postgres un
   * `QueryResult`. Normalizarlo acá evita que la diferencia se filtre a cada
   * consulta y que un test en verde contra PGlite falle en producción.
   */
  query<T = Record<string, unknown>>(query: SQL): Promise<T[]>;
  /**
   * Ejecuta SQL crudo multi-sentencia. Solo para migraciones: el resto del
   * sistema pasa por Drizzle.
   */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** Extrae las filas sin importar cuál de los dos drivers respondió. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** Cualquier cosa capaz de ejecutar SQL: la conexión o una transacción. */
export interface Executor {
  execute(query: SQL): Promise<unknown>;
}

/**
 * Ejecuta SQL sobre una conexión o una transacción y normaliza las filas.
 *
 * Dentro de `drizzle.transaction()` no hay acceso al helper `query` de `Db`, así
 * que esta función es la que usan los servicios para no volver a lidiar con la
 * diferencia de forma entre drivers.
 */
export async function rows<T = Record<string, unknown>>(
  executor: Executor,
  query: SQL,
): Promise<T[]> {
  return rowsOf<T>(await executor.execute(query));
}

/** Conexión en memoria para tests y desarrollo local. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");

  const client = new PGlite(dataDir);
  await client.waitReady;

  const db = drizzle(client, { schema }) as unknown as Database;

  return {
    drizzle: db,
    query: async (query) => rowsOf(await db.execute(query)),
    exec: async (sql) => {
      await client.exec(sql);
    },
    close: async () => {
      await client.close();
    },
  };
}

/** Conexión a un Postgres real. */
export async function createPostgresDb(connectionString: string): Promise<Db> {
  const pg = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");

  const pool = new pg.default.Pool({ connectionString });

  const db = drizzle(pool, { schema }) as unknown as Database;

  return {
    drizzle: db,
    query: async (query) => rowsOf(await db.execute(query)),
    exec: async (sql) => {
      // Sin parámetros, node-postgres usa el protocolo simple y acepta varias
      // sentencias en un solo query — que es lo que necesita una migración.
      await pool.query(sql);
    },
    close: async () => {
      await pool.end();
    },
  };
}

/**
 * Abre la conexión según el entorno. Con `DATABASE_URL` va a Postgres; sin ella,
 * levanta PGlite en memoria.
 */
export async function createDb(connectionString?: string): Promise<Db> {
  const url = connectionString ?? process.env.DATABASE_URL;
  return url ? createPostgresDb(url) : createPgliteDb();
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Aplica las migraciones pendientes, en orden alfabético de nombre de archivo.
 *
 * **Registra cuáles ya corrieron.** Sin eso, cada arranque intentaba aplicarlas
 * todas de nuevo: contra una base en memoria da igual porque siempre nace
 * vacía, pero contra un Postgres persistente el segundo arranque muere con
 * "relation already exists". El primer deploy anda y todos los siguientes no.
 *
 * Corre dentro de una transacción con un lock de nivel transacción: en un
 * deploy con solapamiento pueden arrancar dos máquinas a la vez, y sin el lock
 * las dos aplicarían la misma migración. Se usa `pg_advisory_xact_lock` y no la
 * variante de sesión porque el lock de sesión se pierde detrás de un pooler en
 * modo transacción, que es justo cómo se conecta a Supabase.
 *
 * Devuelve las que aplicó en esta corrida, no todas.
 */
export async function runMigrations(db: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const aplicadas = new Set(
    (await db.query<{ name: string }>(sql`SELECT name FROM schema_migration`)).map((r) => r.name),
  );

  const pendientes = files.filter((f) => !aplicadas.has(f));
  if (pendientes.length === 0) return [];

  for (const file of pendientes) {
    const contenido = await readFile(join(MIGRATIONS_DIR, file), "utf8");

    // Cada migración va en su propia transacción: si una falla a la mitad, se
    // deshace entera y las anteriores quedan aplicadas y registradas. Postgres
    // hace transaccional casi todo el DDL, así que esto no es una ilusión.
    await db.exec(`
      BEGIN;
      SELECT pg_advisory_xact_lock(${MIGRATION_LOCK});
      ${contenido}
      INSERT INTO schema_migration (name) VALUES ('${file.replace(/'/g, "''")}')
        ON CONFLICT (name) DO NOTHING;
      COMMIT;
    `);
  }

  return pendientes;
}

/**
 * Identificador del lock de migraciones. Cualquier número constante sirve; lo
 * único que importa es que sea el mismo en todos los procesos.
 */
const MIGRATION_LOCK = 8_274_193;

/** Base limpia y migrada, lista para un test. */
export async function createTestDb(): Promise<Db> {
  const db = await createPgliteDb();
  await runMigrations(db);
  return db;
}
