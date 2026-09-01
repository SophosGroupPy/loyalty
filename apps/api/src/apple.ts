/**
 * Web service de actualización de Apple.
 *
 * El flujo de Apple es al revés del de Google. No se le puede mandar contenido a
 * un pase: el iPhone se registra contra este servicio cuando el cliente agrega
 * la tarjeta, y después se le manda un push **con payload vacío** para que
 * vuelva a pedir el pase entero. El push no lleva información y el cliente no lo
 * ve; lo que ve es la tarjeta ya actualizada.
 *
 * Los endpoints y sus rutas los fija Apple, no nosotros. Viven fuera de `/v1/`
 * porque ese prefijo exige token de producto y acá quien llama es un teléfono,
 * que se autentica con el `authenticationToken` del propio pase.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";

/**
 * Credencial que el pase le muestra al web service.
 *
 * Se deriva del serial en vez de guardarse: una columna menos que proteger, y
 * un pase perdido no expone nada que no esté ya en el pase. Va con separador de
 * dominio para que la misma clave no produzca el mismo valor en otro uso.
 *
 * Rotar `signingKey` invalida el web service de todos los pases ya emitidos —
 * el mismo compromiso que ya tiene esa clave para los tokens de producto.
 */
export function passAuthToken(serialNumber: string, signingKey: Uint8Array): string {
  return createHmac("sha256", signingKey).update(`apple-pass:${serialNumber}`).digest("hex");
}

/**
 * Valida el header `Authorization: ApplePass <token>`.
 *
 * Comparación en tiempo constante: la diferencia entre un token casi correcto y
 * uno equivocado no puede medirse desde afuera.
 */
export function verifyPassAuth(
  header: string | undefined,
  serialNumber: string,
  signingKey: Uint8Array,
): boolean {
  if (!header?.startsWith("ApplePass ")) return false;

  const provided = Buffer.from(header.slice("ApplePass ".length).trim(), "utf8");
  const expected = Buffer.from(passAuthToken(serialNumber, signingKey), "utf8");

  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// ---------------------------------------------------------------------------

export interface RegistrationInput {
  deviceLibraryIdentifier: string;
  passTypeIdentifier: string;
  serialNumber: string;
  pushToken: string;
}

/**
 * Registra un dispositivo, o actualiza su push token si ya estaba.
 *
 * Apple distingue los dos casos con el código de respuesta: 201 la primera vez,
 * 200 si ya estaba. El token de APNs cambia solo cada tanto y el dispositivo
 * re-registra cuando pasa, así que el update no es un caso raro.
 */
export async function registerDevice(
  db: Db,
  input: RegistrationInput,
): Promise<"created" | "updated" | "unknown_pass"> {
  const membership = await rows<{ id: string }>(
    db.drizzle,
    sql`SELECT id FROM membership WHERE serial_number = ${input.serialNumber}`,
  );
  if (membership.length === 0) return "unknown_pass";

  const existing = await rows<{ id: string }>(
    db.drizzle,
    sql`SELECT id FROM apple_device_registration
        WHERE device_library_identifier = ${input.deviceLibraryIdentifier}
          AND pass_type_identifier = ${input.passTypeIdentifier}
          AND serial_number = ${input.serialNumber}`,
  );

  if (existing.length > 0) {
    await rows(
      db.drizzle,
      sql`UPDATE apple_device_registration
          SET push_token = ${input.pushToken}, updated_at = now()
          WHERE id = ${existing[0]!.id}`,
    );
    return "updated";
  }

  await rows(
    db.drizzle,
    sql`INSERT INTO apple_device_registration
          (device_library_identifier, pass_type_identifier, serial_number,
           push_token, membership_id)
        VALUES (${input.deviceLibraryIdentifier}, ${input.passTypeIdentifier},
                ${input.serialNumber}, ${input.pushToken}, ${membership[0]!.id})`,
  );
  return "created";
}

/** El cliente borró la tarjeta de su Wallet. Devuelve `false` si no estaba. */
export async function unregisterDevice(
  db: Db,
  input: Omit<RegistrationInput, "pushToken">,
): Promise<boolean> {
  const deleted = await rows<{ id: string }>(
    db.drizzle,
    sql`DELETE FROM apple_device_registration
        WHERE device_library_identifier = ${input.deviceLibraryIdentifier}
          AND pass_type_identifier = ${input.passTypeIdentifier}
          AND serial_number = ${input.serialNumber}
        RETURNING id`,
  );
  return deleted.length > 0;
}

export interface UpdatedPasses {
  serialNumbers: string[];
  /** Marca que el dispositivo devuelve en la próxima consulta. */
  lastUpdated: string;
}

/**
 * Qué pases de este dispositivo cambiaron desde la última consulta.
 *
 * Se filtra por `content_updated_at` y no por `last_synced_at`: lo que pregunta
 * el dispositivo es qué cambió, no qué se logró empujar. Con la segunda, un push
 * fallido sacaría el pase de la lista, que es lo contrario de lo que hay que
 * hacer.
 */
export async function passesUpdatedSince(
  db: Db,
  deviceLibraryIdentifier: string,
  passTypeIdentifier: string,
  since?: string,
): Promise<UpdatedPasses> {
  const sinceDate = since ? new Date(Number(since)) : null;
  const valid = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null;

  const found = await rows<{ serial_number: string; content_updated_at: Date }>(
    db.drizzle,
    valid
      ? sql`SELECT r.serial_number, pi.content_updated_at
            FROM apple_device_registration r
            JOIN pass_instance pi
              ON pi.membership_id = r.membership_id AND pi.platform = 'apple'
            WHERE r.device_library_identifier = ${deviceLibraryIdentifier}
              AND r.pass_type_identifier = ${passTypeIdentifier}
              AND pi.content_updated_at > ${valid.toISOString()}`
      : sql`SELECT r.serial_number, pi.content_updated_at
            FROM apple_device_registration r
            JOIN pass_instance pi
              ON pi.membership_id = r.membership_id AND pi.platform = 'apple'
            WHERE r.device_library_identifier = ${deviceLibraryIdentifier}
              AND r.pass_type_identifier = ${passTypeIdentifier}`,
  );

  const latest = found.reduce(
    (max, row) => Math.max(max, new Date(row.content_updated_at).getTime()),
    0,
  );

  return {
    serialNumbers: found.map((r) => r.serial_number),
    // Si no hubo cambios se devuelve la marca que trajo el dispositivo, para no
    // hacerle retroceder el reloj y que vuelva a pedir todo.
    lastUpdated: String(latest > 0 ? latest : (valid?.getTime() ?? 0)),
  };
}

/** Marca que el contenido del pase cambió, para que el dispositivo lo note. */
export async function markPassUpdated(db: Db, membershipId: string): Promise<void> {
  await rows(
    db.drizzle,
    sql`UPDATE pass_instance SET content_updated_at = now()
        WHERE membership_id = ${membershipId} AND platform = 'apple'`,
  );
}

/** Push tokens de todos los dispositivos que tienen este pase. */
export async function pushTokensFor(
  db: Db,
  passTypeIdentifier: string,
  serialNumber: string,
): Promise<string[]> {
  const found = await rows<{ push_token: string }>(
    db.drizzle,
    sql`SELECT push_token FROM apple_device_registration
        WHERE pass_type_identifier = ${passTypeIdentifier}
          AND serial_number = ${serialNumber}`,
  );
  return found.map((r) => r.push_token);
}

/**
 * Baja de un token que APNs rechazó por inválido.
 *
 * Apple devuelve `Unregistered` / `BadDeviceToken` cuando el pase ya no está en
 * ese dispositivo. Insistir contra un token muerto es lo que hace que Apple
 * empiece a limitar al emisor, y el emisor es uno solo para todo el ecosistema.
 */
export async function dropPushToken(db: Db, pushToken: string): Promise<void> {
  await rows(
    db.drizzle,
    sql`DELETE FROM apple_device_registration WHERE push_token = ${pushToken}`,
  );
}
