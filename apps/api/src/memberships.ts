/**
 * Alta e identificación de tarjetas.
 *
 * Acá vive la separación que define el producto: **una `person` compartida,
 * muchas `membership` independientes**. El celular verificado es lo único que se
 * comparte entre comercios; el saldo, el perfil y el programa no.
 */

import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";

/** Alfabeto sin caracteres ambiguos: no hay I, L, O ni U. */
const SERIAL_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Serial de la tarjeta. Es lo que va en el QR y lo que el POS escanea.
 *
 * Identifica, pero no autoriza: toda acumulación y todo canje se validan contra
 * el servidor. Por eso puede ser estático y no pasa nada si alguien comparte una
 * captura de su tarjeta.
 */
export function generateSerial(): string {
  const bytes = randomBytes(12);
  let serial = "";
  for (const byte of bytes) {
    serial += SERIAL_ALPHABET[byte % SERIAL_ALPHABET.length];
  }
  return serial;
}

/**
 * Normaliza un número a E.164.
 *
 * En Paraguay la gente escribe su celular de muchas formas (0993 427654,
 * 993427654, +595 993 427654) y todas son la misma persona. Sin normalizar, la
 * identidad compartida se rompe: el mismo cliente entraría dos veces y el alta
 * de un toque en el segundo comercio no funcionaría nunca.
 */
export function normalizePhone(input: string, countryCode = "595"): string | null {
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (!digits) return null;

  let national: string;
  if (hasPlus) {
    return digits.length >= 8 ? `+${digits}` : null;
  }
  if (digits.startsWith(countryCode) && digits.length > countryCode.length + 6) {
    return `+${digits}`;
  }
  if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    national = digits;
  }

  if (national.length < 8 || national.length > 12) return null;
  return `+${countryCode}${national}`;
}

export interface EnrollInput {
  merchantId: string;
  programId: string;
  phone: string;
  /** Nombre tal como lo conoce ESTE comercio. No toca la ficha de los demás. */
  displayName?: string;
  consentVersion: string;
  /** El alta desde la landing verifica el celular por OTP; la manual del POS no. */
  phoneVerified?: boolean;
}

export interface EnrollOutput {
  membershipId: string;
  personId: string;
  serialNumber: string;
  balance: number;
  /** `false` cuando la tarjeta ya existía: el alta es idempotente. */
  created: boolean;
  /** `true` si la persona ya estaba en el ecosistema — el alta de un toque. */
  personExisted: boolean;
}

/**
 * Da de alta una tarjeta. Si la persona ya existe en el ecosistema reutiliza su
 * registro; si ya tiene tarjeta en este programa, la devuelve sin duplicarla.
 */
export async function enroll(db: Db, input: EnrollInput): Promise<EnrollOutput> {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error(`Número de celular inválido: ${input.phone}`);

  return db.drizzle.transaction(async (tx) => {
    const before = await rows<{ id: string }>(
      tx,
      sql`SELECT id FROM person WHERE phone_e164 = ${phone}`,
    );
    const personExisted = before.length > 0;

    // La persona es global: el mismo celular en otro comercio reutiliza el
    // registro en vez de crear uno nuevo. Eso es lo que hace que el segundo alta
    // del ecosistema no vuelva a pedir OTP.
    const upserted = await rows<{ id: string }>(
      tx,
      sql`INSERT INTO person (phone_e164, consent_version, phone_verified_at)
          VALUES (${phone}, ${input.consentVersion},
                  ${input.phoneVerified ? sql`now()` : sql`NULL`})
          ON CONFLICT (phone_e164) DO UPDATE
            SET phone_verified_at = COALESCE(person.phone_verified_at, EXCLUDED.phone_verified_at)
          RETURNING id`,
    );
    const personId = upserted[0]?.id;
    if (!personId) throw new Error("no se pudo resolver la persona");

    const serial = generateSerial();
    const inserted = await rows<{ id: string; serial_number: string; balance: number }>(
      tx,
      sql`INSERT INTO membership
            (person_id, program_id, merchant_id, serial_number, display_name, balance, status)
          VALUES (${personId}, ${input.programId}, ${input.merchantId}, ${serial},
                  ${input.displayName ?? null}, 0, 'active')
          ON CONFLICT (person_id, program_id) DO NOTHING
          RETURNING id, serial_number, balance`,
    );

    if (inserted[0]) {
      return {
        membershipId: inserted[0].id,
        personId,
        serialNumber: inserted[0].serial_number,
        balance: inserted[0].balance,
        created: true,
        personExisted,
      };
    }

    const existing = await rows<{ id: string; serial_number: string; balance: number }>(
      tx,
      sql`SELECT id, serial_number, balance FROM membership
          WHERE person_id = ${personId} AND program_id = ${input.programId}`,
    );
    const membership = existing[0];
    if (!membership) throw new Error("no se pudo resolver la membresía");

    return {
      membershipId: membership.id,
      personId,
      serialNumber: membership.serial_number,
      balance: membership.balance,
      created: false,
      personExisted,
    };
  });
}

export interface MembershipView {
  id: string;
  serialNumber: string;
  displayName: string | null;
  balance: number;
  tier: string | null;
  unit: "points" | "stamps";
  status: string;
  /** Beneficios que este cliente ya puede canjear, listos para mostrar en el POS. */
  availableRewards: { id: string; name: string; cost: number }[];
}

/**
 * Busca una tarjeta dentro de un comercio, por celular o por serial.
 *
 * **Siempre acotada a `merchantId`.** Un comercio no puede consultar la tarjeta
 * de otro ni enterarse de que su cliente tiene tarjeta en otro lado.
 *
 * Devuelve los beneficios disponibles junto con el saldo: es lo que hace que el
 * cajero vea "este cliente tiene un café gratis" en el momento en que lo busca,
 * sin depender de ninguna notificación.
 */
export async function lookup(
  db: Db,
  merchantId: string,
  by: { phone?: string; serial?: string },
): Promise<MembershipView | null> {
  const phone = by.phone ? normalizePhone(by.phone) : null;
  if (!phone && !by.serial) return null;

  const found = await rows<{
    id: string;
    serial_number: string;
    display_name: string | null;
    balance: number;
    tier: string | null;
    status: string;
    kind: "points" | "stamps";
  }>(
    db.drizzle,
    phone
      ? sql`SELECT m.id, m.serial_number, m.display_name, m.balance, m.tier, m.status, p.kind
            FROM membership m
            JOIN person per ON per.id = m.person_id
            JOIN program p ON p.id = m.program_id
            WHERE m.merchant_id = ${merchantId}
              AND per.phone_e164 = ${phone}
              AND per.deleted_at IS NULL`
      : sql`SELECT m.id, m.serial_number, m.display_name, m.balance, m.tier, m.status, p.kind
            FROM membership m
            JOIN person per ON per.id = m.person_id
            JOIN program p ON p.id = m.program_id
            WHERE m.merchant_id = ${merchantId}
              AND m.serial_number = ${by.serial}
              AND per.deleted_at IS NULL`,
  );

  const membership = found[0];
  if (!membership) return null;

  const rewards = await rows<{ id: string; name: string; cost: number }>(
    db.drizzle,
    sql`SELECT id, name, cost FROM reward
        WHERE merchant_id = ${merchantId}
          AND status = 'active'
          AND cost <= ${membership.balance}
        ORDER BY cost DESC`,
  );

  return {
    id: membership.id,
    serialNumber: membership.serial_number,
    displayName: membership.display_name,
    balance: membership.balance,
    tier: membership.tier,
    unit: membership.kind === "stamps" ? "stamps" : "points",
    status: membership.status,
    availableRewards: rewards,
  };
}
