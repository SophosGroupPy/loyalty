import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, runMigrations, type Db } from "./client.js";
import { schema } from "./schema.js";

let db: Db;

/**
 * Afirma que una consulta falló con un mensaje concreto de Postgres.
 *
 * Drizzle envuelve el error del driver en uno propio ("Failed query: …") y deja
 * el mensaje original en `cause`, así que mirar solo `message` haría pasar el
 * test ante cualquier fallo — incluido un typo en el SQL.
 */
async function expectQueryError(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught, "se esperaba que la consulta fallara").toBeDefined();

  const messages: string[] = [];
  for (let e = caught; e; e = (e as { cause?: unknown }).cause) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") messages.push(message);
  }

  expect(messages.join(" | ")).toMatch(pattern);
}

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

describe("migraciones", () => {
  it("correrlas de nuevo sobre la misma base no rompe nada", async () => {
    // Es lo que pasa en cada arranque contra un Postgres persistente. Sin tabla
    // de control, el segundo intento moría con "relation already exists": el
    // primer deploy andaba y todos los siguientes no.
    const segunda = await runMigrations(db);
    expect(segunda).toEqual([]);

    // Y la base sigue usable: no quedó a medio camino.
    const tablas = await db.query<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(Number(tablas[0]!.n)).toBeGreaterThan(10);
  });

  it("registra cuáles aplicó", async () => {
    const aplicadas = await db.query<{ name: string }>(
      sql`SELECT name FROM schema_migration ORDER BY name`,
    );
    expect(aplicadas.map((r) => r.name)).toContain("0001_init.sql");
    expect(aplicadas.length).toBeGreaterThanOrEqual(8);
  });

  it("crea todas las tablas del esquema", async () => {
    const rows = await db.query<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' ORDER BY table_name`,
    );

    expect(rows.map((r) => r.table_name)).toEqual([
      "apple_device_registration",
      "campaign",
      "event",
      "ledger_entry",
      "membership",
      "merchant",
      "merchant_location",
      "notification",
      "otp_challenge",
      "pass_certificate",
      "pass_instance",
      "person",
      "product",
      "program",
      "redemption",
      "reward",
      "schema_migration",
      "webhook_delivery",
      "webhook_endpoint",
    ]);
  });

  /**
   * El DDL vive en SQL y la vista tipada en TypeScript. Si alguien agrega una
   * columna en uno y se olvida del otro, el error aparece acá y no en runtime.
   */
  it("mantiene el esquema Drizzle sincronizado con el SQL", async () => {
    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      const declared = config.columns.map((c) => c.name).sort();

      const rows = await db.query<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ${config.name}`,
      );

      expect(
        rows.map((r) => r.column_name).sort(),
        `columnas de ${config.name}`,
      ).toEqual(declared);
    }
  });
});

describe("garantías del ledger", () => {
  /** Crea la cadena mínima product → merchant → program → person → membership. */
  async function seedMembership(): Promise<string> {
    const rows = await db.query<{ id: string }>(sql`
      WITH p AS (
        INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid', 'hash') RETURNING id
      ), m AS (
        INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
        SELECT id, 'r-1', 'don-julio', 'Don Julio SA', 'Don Julio' FROM p RETURNING id
      ), pr AS (
        INSERT INTO program (merchant_id, kind, config, status)
        SELECT id, 'points', '{"kind":"points","earn":[]}'::jsonb, 'active' FROM m
        RETURNING id, merchant_id
      ), per AS (
        INSERT INTO person (phone_e164, consent_version)
        VALUES ('+595993427654', 'v1') RETURNING id
      )
      INSERT INTO membership (person_id, program_id, merchant_id, serial_number, balance, status)
      SELECT per.id, pr.id, pr.merchant_id, 'SN-1', 0, 'active' FROM per, pr
      RETURNING id
    `);

    const id = rows[0]?.id;
    if (!id) throw new Error("no se pudo crear la membresía de prueba");
    return id;
  }

  async function insertEntry(membershipId: string, amount: number): Promise<string> {
    const rows = await db.query<{ id: string }>(sql`
      INSERT INTO ledger_entry (membership_id, merchant_id, kind, amount, balance_after, business_day)
      SELECT id, merchant_id, 'earn', ${amount}, ${amount}, '2026-08-13'
      FROM membership WHERE id = ${membershipId}
      RETURNING id
    `);

    const id = rows[0]?.id;
    if (!id) throw new Error("no se pudo insertar el asiento");
    return id;
  }

  it("rechaza modificar un asiento ya escrito", async () => {
    const membershipId = await seedMembership();
    const entryId = await insertEntry(membershipId, 10);

    await expectQueryError(
      db.query(sql`UPDATE ledger_entry SET amount = 999 WHERE id = ${entryId}`),
      /append-only/,
    );
  });

  it("rechaza borrar un asiento", async () => {
    const membershipId = await seedMembership();
    const entryId = await insertEntry(membershipId, 10);

    await expectQueryError(
      db.query(sql`DELETE FROM ledger_entry WHERE id = ${entryId}`),
      /append-only/,
    );
  });

  it("rechaza asientos en cero", async () => {
    const membershipId = await seedMembership();
    await expect(insertEntry(membershipId, 0)).rejects.toThrow();
  });

  it("rechaza dos asientos para el mismo evento", async () => {
    const membershipId = await seedMembership();

    const eventRows = await db.query<{ id: string }>(sql`
      INSERT INTO event (product_id, merchant_id, idempotency_key, type, occurred_at)
      SELECT p.id, m.id, 'order-42', 'order.paid', now()
      FROM merchant m JOIN product p ON p.id = m.product_id
      RETURNING id
    `);
    const eventId = eventRows[0]?.id;

    const write = () =>
      db.query(sql`
        INSERT INTO ledger_entry
          (membership_id, merchant_id, kind, amount, balance_after, business_day, source_event_id)
        SELECT id, merchant_id, 'earn', 5, 5, '2026-08-13', ${eventId}
        FROM membership WHERE id = ${membershipId}
      `);

    await write();
    await expect(write()).rejects.toThrow();
  });
});

describe("aislamiento y unicidad", () => {
  it("permite el mismo external_id en productos distintos", async () => {
    await db.query(sql`
      INSERT INTO product (slug, name, client_id, client_secret_hash) VALUES
        ('elmenu', 'ElMenu', 'cid-elmenu', 'h'),
        ('noctu', 'Noctu', 'cid-noctu', 'h')
    `);

    // El comercio "42" de ElMenu y el "42" de Noctu son comercios distintos.
    await db.query(sql`
      INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
      SELECT id, '42', slug || '-42', 'Razón Social', 'Comercio' FROM product
    `);

    const rows = await db.query<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM merchant`,
    );
    expect(rows[0]?.count).toBe("2");
  });

  it("rechaza dos veces el mismo external_id dentro de un producto", async () => {
    await db.query(sql`
      INSERT INTO product (slug, name, client_id, client_secret_hash)
      VALUES ('elmenu', 'ElMenu', 'cid', 'h')
    `);

    const insert = (slug: string) =>
      db.query(sql`
        INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
        SELECT id, '42', ${slug}, 'RS', 'C' FROM product WHERE slug = 'elmenu'
      `);

    await insert("a");
    await expect(insert("b")).rejects.toThrow();
  });

  it("rechaza un segundo programa activo para el mismo comercio", async () => {
    await db.query(sql`
      INSERT INTO product (slug, name, client_id, client_secret_hash)
      VALUES ('elmenu', 'ElMenu', 'cid', 'h')
    `);
    await db.query(sql`
      INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
      SELECT id, '42', 'don-julio', 'RS', 'C' FROM product
    `);

    const addProgram = (status: string) =>
      db.query(sql`
        INSERT INTO program (merchant_id, kind, config, status)
        SELECT id, 'points', '{}'::jsonb, ${status} FROM merchant
      `);

    await addProgram("active");
    await expect(addProgram("active")).rejects.toThrow();
    // Uno pausado sí puede convivir: sirve de historial.
    await expect(addProgram("paused")).resolves.toBeDefined();
  });

  it("rechaza dos personas con el mismo celular", async () => {
    const insert = () =>
      db.query(sql`
        INSERT INTO person (phone_e164, consent_version) VALUES ('+595993427654', 'v1')
      `);

    await insert();
    await expect(insert()).rejects.toThrow();
  });
});
