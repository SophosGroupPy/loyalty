/**
 * Alta del cliente con verificación del celular.
 *
 * **Es la pieza de mayor riesgo del sistema.** El celular verificado es la clave
 * de la identidad compartida, así que verificar un número ajeno no es hacerse
 * pasar por alguien en un comercio: es apropiarse de su identidad en todo el
 * ecosistema, con acceso a los saldos que tenga en cualquier otro.
 *
 * De ahí las cuatro defensas, que se sostienen entre sí:
 *  1. Código generado con `crypto.randomInt`, no `Math.random`.
 *  2. Guardado con scrypt, nunca en claro.
 *  3. Tope de intentos por desafío, y uno solo vigente por número y comercio.
 *  4. Límite de envíos por número, para que reintentar no amplíe la superficie.
 */

import { randomInt } from "node:crypto";

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";

import { hashSecret, verifySecret } from "./auth.js";
import { enroll, normalizePhone, type EnrollOutput } from "./memberships.js";

/** Seis dígitos: el estándar que la gente espera de un SMS. */
const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;
/** Tras estos intentos el desafío se quema, aunque no haya vencido. */
const MAX_ATTEMPTS = 5;
/** Envíos permitidos por número en la ventana. Frena el abuso y el gasto. */
const MAX_SENDS_PER_HOUR = 5;

export interface OtpMessage {
  phone: string;
  code: string;
  /** Nombre del comercio, para que el mensaje diga de parte de quién llega. */
  merchantName: string;
}

export interface OtpSender {
  send(message: OtpMessage): Promise<void>;
}

/**
 * Sender de desarrollo: imprime el código por consola.
 *
 * Permite recorrer el alta entera sin proveedor de SMS ni de WhatsApp, que es
 * la situación hasta que se contrate uno.
 */
export function createConsoleOtpSender(
  log: (message: string) => void = console.log,
): OtpSender {
  return {
    async send({ phone, code, merchantName }) {
      log(`[otp] ${merchantName} → ${phone}: ${code}`);
    },
  };
}

export type StartOutcome =
  | { status: "sent"; expiresAt: Date }
  | { status: "rate_limited"; retryAfterMinutes: number }
  | { status: "invalid_phone" };

/**
 * Genera y envía un código.
 *
 * **Responde igual exista o no la persona.** Si el resultado cambiara según eso,
 * la pantalla de alta se convertiría en un oráculo para averiguar si un número
 * es cliente de un comercio — justo el dato que el comercio no puede filtrar.
 */
export async function startEnrollment(
  db: Db,
  sender: OtpSender,
  input: { merchantId: string; merchantName: string; phone: string },
): Promise<StartOutcome> {
  const phone = normalizePhone(input.phone);
  if (!phone) return { status: "invalid_phone" };

  const recent = await rows<{ count: number }>(
    db.drizzle,
    sql`SELECT count(*)::int AS count FROM otp_challenge
        WHERE phone_e164 = ${phone} AND created_at > now() - interval '1 hour'`,
  );

  if ((recent[0]?.count ?? 0) >= MAX_SENDS_PER_HOUR) {
    return { status: "rate_limited", retryAfterMinutes: 60 };
  }

  const code = String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  await db.drizzle.transaction(async (tx) => {
    // Pedir un código nuevo invalida el anterior: dos códigos válidos a la vez
    // duplicarían la superficie de adivinación sin darle nada al usuario.
    await rows(
      tx,
      sql`UPDATE otp_challenge SET consumed_at = now()
          WHERE phone_e164 = ${phone} AND merchant_id = ${input.merchantId}
            AND consumed_at IS NULL`,
    );

    await rows(
      tx,
      sql`INSERT INTO otp_challenge (phone_e164, merchant_id, code_hash, expires_at)
          VALUES (${phone}, ${input.merchantId}, ${await hashSecret(code)},
                  ${expiresAt.toISOString()})`,
    );
  });

  await sender.send({ phone, code, merchantName: input.merchantName });

  return { status: "sent", expiresAt };
}

export type VerifyOutcome =
  | { status: "verified"; membership: EnrollOutput }
  | { status: "invalid_code"; attemptsLeft: number }
  | { status: "expired" }
  | { status: "no_challenge" }
  | { status: "too_many_attempts" };

export interface VerifyInput {
  merchantId: string;
  programId: string;
  phone: string;
  code: string;
  displayName?: string;
  consentVersion: string;
}

/**
 * Verifica el código y, si es correcto, da de alta la tarjeta.
 *
 * El alta ocurre acá y no antes: una `membership` solo existe con el celular
 * verificado, porque ese celular es lo que la vincula a la identidad compartida.
 */
export async function verifyEnrollment(
  db: Db,
  input: VerifyInput,
): Promise<VerifyOutcome> {
  const phone = normalizePhone(input.phone);
  if (!phone) return { status: "no_challenge" };

  const found = await rows<{
    id: string;
    code_hash: string;
    attempts: number;
    expires_at: string;
  }>(
    db.drizzle,
    sql`SELECT id, code_hash, attempts, expires_at FROM otp_challenge
        WHERE phone_e164 = ${phone} AND merchant_id = ${input.merchantId}
          AND consumed_at IS NULL`,
  );

  const challenge = found[0];
  if (!challenge) return { status: "no_challenge" };

  if (new Date(challenge.expires_at) < new Date()) {
    await rows(
      db.drizzle,
      sql`UPDATE otp_challenge SET consumed_at = now() WHERE id = ${challenge.id}`,
    );
    return { status: "expired" };
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    await rows(
      db.drizzle,
      sql`UPDATE otp_challenge SET consumed_at = now() WHERE id = ${challenge.id}`,
    );
    return { status: "too_many_attempts" };
  }

  // La comparación es en tiempo constante (la hace `verifySecret`), para que el
  // tiempo de respuesta no filtre cuántos dígitos coincidían.
  if (!(await verifySecret(input.code, challenge.code_hash))) {
    const updated = await rows<{ attempts: number }>(
      db.drizzle,
      sql`UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = ${challenge.id}
          RETURNING attempts`,
    );
    const attempts = updated[0]?.attempts ?? MAX_ATTEMPTS;

    if (attempts >= MAX_ATTEMPTS) {
      await rows(
        db.drizzle,
        sql`UPDATE otp_challenge SET consumed_at = now() WHERE id = ${challenge.id}`,
      );
      return { status: "too_many_attempts" };
    }

    return { status: "invalid_code", attemptsLeft: MAX_ATTEMPTS - attempts };
  }

  await rows(
    db.drizzle,
    sql`UPDATE otp_challenge SET consumed_at = now() WHERE id = ${challenge.id}`,
  );

  const membership = await enroll(db, {
    merchantId: input.merchantId,
    programId: input.programId,
    phone,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    consentVersion: input.consentVersion,
    phoneVerified: true,
  });

  return { status: "verified", membership };
}

export const OTP_LIMITS = {
  codeLength: CODE_LENGTH,
  ttlMinutes: CODE_TTL_MINUTES,
  maxAttempts: MAX_ATTEMPTS,
  maxSendsPerHour: MAX_SENDS_PER_HOUR,
} as const;
