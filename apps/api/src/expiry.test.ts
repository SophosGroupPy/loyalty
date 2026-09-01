/**
 * Vencimiento de puntos.
 *
 * El caso que importa es el FIFO: un cliente que canjea seguido no puede perder
 * puntos que ya gastó. Hacerlo mal no rompe nada visible — simplemente le saca
 * puntos de más a los mejores clientes, que son los que más canjean.
 */

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { auditBalance } from "./ledger.js";
import { runExpiry } from "./expiry.js";

let db: Db;
let merchantId: string;
let programId: string;
let personId: string;

const AHORA = new Date("2026-09-01T12:00:00Z");

/** Fecha a N meses antes de `AHORA`. */
function haceMeses(months: number): string {
  const d = new Date(AHORA);
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

/**
 * Crea un programa. El esquema no admite dos activos por comercio, así que cada
 * programa extra viene con su propio comercio — que es además el caso real: dos
 * comercios distintos con plazos distintos.
 */
async function crearPrograma(config: Record<string, unknown>, slug = "don-julio") {
  const merchant = slug === "don-julio" ? merchantId : await crearComercio(slug);
  const [program] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO program (merchant_id, kind, config, status)
        VALUES (${merchant}, 'points', ${JSON.stringify(config)}::jsonb, 'active')
        RETURNING id`,
  );
  return { id: program!.id, merchantId: merchant };
}

async function crearComercio(slug: string) {
  const [product] = await rows<{ id: string }>(
    db.drizzle,
    sql`SELECT id FROM product LIMIT 1`,
  );
  const [merchant] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
        VALUES (${product!.id}, ${slug}, ${slug}, ${slug}, ${slug}) RETURNING id`,
  );
  return merchant!.id;
}

async function crearTarjeta(serial: string, program?: { id: string; merchantId: string }) {
  const target = program ?? { id: programId, merchantId };
  const [m] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO membership (person_id, program_id, merchant_id, serial_number)
        VALUES (${personId}, ${target.id}, ${target.merchantId}, ${serial}) RETURNING id`,
  );
  return m!.id;
}

/** Escribe un asiento con fecha arbitraria y deja el saldo consistente. */
async function asiento(membershipId: string, amount: number, createdAt: string) {
  const [prev] = await rows<{ balance: number; merchant_id: string }>(
    db.drizzle,
    sql`SELECT balance, merchant_id FROM membership WHERE id = ${membershipId}`,
  );
  const after = prev!.balance + amount;

  await rows(
    db.drizzle,
    sql`INSERT INTO ledger_entry
          (membership_id, merchant_id, kind, amount, balance_after, business_day, created_at)
        VALUES (${membershipId}, ${prev!.merchant_id}, ${amount > 0 ? "earn" : "redeem"},
                ${amount}, ${after}, ${createdAt.slice(0, 10)}, ${createdAt})`,
  );
  await rows(
    db.drizzle,
    sql`UPDATE membership SET balance = ${after} WHERE id = ${membershipId}`,
  );
}

const saldoDe = async (id: string) =>
  (
    await rows<{ balance: number }>(
      db.drizzle,
      sql`SELECT balance FROM membership WHERE id = ${id}`,
    )
  )[0]!.balance;

beforeEach(async () => {
  db = await createTestDb();

  const [product] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid', 'hash') RETURNING id`,
  );
  const [merchant] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO merchant (product_id, external_id, slug, legal_name, display_name)
        VALUES (${product!.id}, 'r-1', 'don-julio', 'Don Julio SA', 'Don Julio') RETURNING id`,
  );
  merchantId = merchant!.id;

  const [person] = await rows<{ id: string }>(
    db.drizzle,
    sql`INSERT INTO person (phone_e164, consent_version, phone_verified_at)
        VALUES ('+595993427654', 'programa/v1', now()) RETURNING id`,
  );
  personId = person!.id;

  programId = (await crearPrograma({ earn: [], expiry: { months: 12 } })).id;
});

afterEach(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------

describe("qué vence", () => {
  it("vence lo acumulado antes del corte", async () => {
    const card = await crearTarjeta("SN-1");
    await asiento(card, 100, haceMeses(13));
    await asiento(card, 50, haceMeses(1));

    const run = await runExpiry(db, AHORA);

    expect(run.cards).toHaveLength(1);
    expect(run.cards[0]?.expired).toBe(100);
    expect(await saldoDe(card)).toBe(50);
  });

  it("no toca lo que todavía no cumplió el plazo", async () => {
    const card = await crearTarjeta("SN-2");
    await asiento(card, 80, haceMeses(11));

    expect((await runExpiry(db, AHORA)).cards).toHaveLength(0);
    expect(await saldoDe(card)).toBe(80);
  });

  it("los canjes salen de los puntos más viejos", async () => {
    // 100 hace 13 meses, 50 hace una semana, 30 canjeados. Vencen 70, no 100:
    // los 30 ya gastados salieron de los viejos. Cobrárselos de nuevo sería
    // castigar justamente al cliente que más canjea.
    const card = await crearTarjeta("SN-3");
    await asiento(card, 100, haceMeses(13));
    await asiento(card, 50, haceMeses(1));
    await asiento(card, -30, haceMeses(0));

    const run = await runExpiry(db, AHORA);

    expect(run.cards[0]?.expired).toBe(70);
    expect(await saldoDe(card)).toBe(50);
  });

  it("no vence nada si ya se canjeó todo lo viejo", async () => {
    const card = await crearTarjeta("SN-4");
    await asiento(card, 100, haceMeses(13));
    await asiento(card, 40, haceMeses(1));
    await asiento(card, -100, haceMeses(2));

    expect((await runExpiry(db, AHORA)).cards).toHaveLength(0);
    expect(await saldoDe(card)).toBe(40);
  });

  it("nunca deja el saldo en negativo", async () => {
    const card = await crearTarjeta("SN-5");
    await asiento(card, 200, haceMeses(20));
    await asiento(card, -150, haceMeses(19));

    await runExpiry(db, AHORA);
    expect(await saldoDe(card)).toBe(0);
  });
});

describe("alcance del job", () => {
  it("ignora los programas sin vencimiento configurado", async () => {
    const sinVencimiento = await crearPrograma({ earn: [] }, "la-vecina");
    const card = await crearTarjeta("SN-6", sinVencimiento);
    await asiento(card, 500, haceMeses(40));

    const run = await runExpiry(db, AHORA);

    expect(run.programs).toBe(1); // solo el que sí tiene vencimiento
    expect(run.cards).toHaveLength(0);
    expect(await saldoDe(card)).toBe(500);
  });

  it("respeta el plazo propio de cada programa", async () => {
    const seisMeses = await crearPrograma({ earn: [], expiry: { months: 6 } }, "bar-z");
    const doceMeses = await crearTarjeta("SN-7");
    const corto = await crearTarjeta("SN-8", seisMeses);

    await asiento(doceMeses, 100, haceMeses(8));
    await asiento(corto, 100, haceMeses(8));

    await runExpiry(db, AHORA);

    expect(await saldoDe(doceMeses)).toBe(100); // 8 meses < 12
    expect(await saldoDe(corto)).toBe(0); // 8 meses > 6
  });

  it("no toca tarjetas dadas de baja", async () => {
    const card = await crearTarjeta("SN-9");
    await asiento(card, 100, haceMeses(15));
    await rows(
      db.drizzle,
      sql`UPDATE membership SET status = 'opted_out' WHERE id = ${card}`,
    );

    expect((await runExpiry(db, AHORA)).cards).toHaveLength(0);
  });
});

describe("invariantes del ledger", () => {
  it("deja el saldo cuadrado contra el ledger", async () => {
    const card = await crearTarjeta("SN-10");
    await asiento(card, 300, haceMeses(14));
    await asiento(card, 60, haceMeses(2));
    await asiento(card, -80, haceMeses(1));

    await runExpiry(db, AHORA);

    // auditBalance recalcula desde los asientos. Si esto falla, el vencimiento
    // escribió el saldo por un camino que se saltó el ledger.
    const audit = await auditBalance(db, card);
    expect(audit.consistent).toBe(true);
  });

  it("registra el vencimiento como asiento, sin borrar nada", async () => {
    const card = await crearTarjeta("SN-11");
    await asiento(card, 100, haceMeses(13));

    await runExpiry(db, AHORA);

    const asientos = await rows<{ kind: string; amount: number; reason: string }>(
      db.drizzle,
      sql`SELECT kind, amount, reason FROM ledger_entry
          WHERE membership_id = ${card} ORDER BY created_at`,
    );
    expect(asientos).toHaveLength(2); // el earn original sigue estando
    expect(asientos[1]?.kind).toBe("expire");
    expect(asientos[1]?.amount).toBe(-100);
    expect(asientos[1]?.reason).toContain("12 meses");
  });

  it("correrlo dos veces no vence dos veces", async () => {
    // El job va a correr en un cron y puede solaparse o reintentarse.
    const card = await crearTarjeta("SN-12");
    await asiento(card, 100, haceMeses(13));

    await runExpiry(db, AHORA);
    const segunda = await runExpiry(db, AHORA);

    expect(segunda.cards).toHaveLength(0);
    expect(await saldoDe(card)).toBe(0);
  });
});
