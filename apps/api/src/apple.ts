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

import { createHmac, createPrivateKey, timingSafeEqual, X509Certificate } from "node:crypto";

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";
import type { PassSigningMaterial } from "@sophos/passes";

import { open, seal, SecretError } from "./secrets.js";

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
  const membership = await rows<{ id: string; merchant_id: string }>(
    db.drizzle,
    sql`SELECT id, merchant_id FROM membership WHERE serial_number = ${input.serialNumber}`,
  );
  if (membership.length === 0) return "unknown_pass";
  const member = membership[0]!;

  // Asegura la fila de pase de Apple.
  //
  // Sin ella, todo el mecanismo de actualización de Apple queda mudo: el web
  // service arma la respuesta de "qué cambió" con un JOIN contra `pass_instance`
  // (ver `passesUpdatedSince`), así que sin fila el teléfono recibe el push pero
  // se le contesta "nada nuevo" y nunca vuelve a pedir el pase. Se crea acá
  // —cuando el dispositivo registra— porque registrarse es la señal de que el
  // pase quedó instalado; antes de eso no hay a quién empujar. `external_id` es
  // el serial, que es la identidad del pase del lado de Apple.
  await rows(
    db.drizzle,
    sql`INSERT INTO pass_instance
          (membership_id, merchant_id, platform, external_id, state)
        VALUES (${member.id}, ${member.merchant_id}, 'apple', ${input.serialNumber}, 'active')
        ON CONFLICT (membership_id, platform) DO UPDATE
          SET state = 'active', last_error = NULL`,
  );

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
                ${input.serialNumber}, ${input.pushToken}, ${member.id})`,
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

/**
 * Marca TODOS los pases de un comercio como cambiados.
 *
 * Hace falta cuando lo que cambió no es el saldo de una tarjeta sino algo del
 * comercio —el diseño, las geocercas— que va adentro de cada pase emitido. Sin
 * esto, el comercio cambia su logo, la pantalla dice que se actualiza solo, y
 * las tarjetas de sus clientes siguen mostrando el logo viejo para siempre:
 * PassKit solo baja una versión nueva si `content_updated_at` avanzó.
 */
export async function markMerchantPassesUpdated(db: Db, merchantId: string): Promise<void> {
  await rows(
    db.drizzle,
    sql`UPDATE pass_instance SET content_updated_at = now()
        WHERE platform = 'apple'
          AND membership_id IN (
            SELECT id FROM membership WHERE merchant_id = ${merchantId}
          )`,
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

// ---------------------------------------------------------------------------
// Material de firma por comercio
// ---------------------------------------------------------------------------

export interface StoreCertificateInput {
  merchantId: string;
  passTypeIdentifier: string;
  certificatePem: string;
  privateKeyPem: string;
}

/**
 * Guarda el certificado de un comercio, cifrando la clave privada.
 *
 * La fecha de vencimiento se lee del propio certificado en vez de pedirla: es
 * un dato que ya está ahí, y escribirlo a mano es una forma barata de que
 * quede mal justo en el campo que sirve para avisar antes de que se caiga.
 */
export async function storeCertificate(
  db: Db,
  input: StoreCertificateInput,
  encryptionKey: Buffer,
): Promise<{ expiresAt: Date }> {
  const cert = new X509Certificate(input.certificatePem);
  const expiresAt = new Date(cert.validTo);

  if (Number.isNaN(expiresAt.getTime())) {
    throw new SecretError("No se pudo leer la fecha de vencimiento del certificado.");
  }

  // Que el certificado corresponda a la clave: si no, todo se guarda bien, todo
  // parece funcionar, y los pases salen con una firma que iOS rechaza sin decir
  // por qué. Comprobarlo acá cuesta una línea.
  if (!cert.checkPrivateKey(createPrivateKey(input.privateKeyPem))) {
    throw new SecretError(
      "El certificado no corresponde a esta clave privada. Revisá que el .cer sea el que emitió Apple a partir de este CSR.",
    );
  }

  const sealed = seal(input.privateKeyPem, encryptionKey);

  await rows(
    db.drizzle,
    sql`INSERT INTO pass_certificate
          (merchant_id, pass_type_identifier, certificate_pem,
           private_key_ciphertext, private_key_nonce, private_key_tag, expires_at)
        VALUES (${input.merchantId}, ${input.passTypeIdentifier}, ${input.certificatePem},
                ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag},
                ${expiresAt.toISOString()})
        ON CONFLICT (merchant_id) DO UPDATE
          SET pass_type_identifier   = EXCLUDED.pass_type_identifier,
              certificate_pem        = EXCLUDED.certificate_pem,
              private_key_ciphertext = EXCLUDED.private_key_ciphertext,
              private_key_nonce      = EXCLUDED.private_key_nonce,
              private_key_tag        = EXCLUDED.private_key_tag,
              expires_at             = EXCLUDED.expires_at`,
  );

  return { expiresAt };
}

/**
 * Recupera el material de firma de un Pass Type ID.
 *
 * Devuelve `null` si ese comercio todavía no tiene certificado cargado, que es
 * un estado normal mientras se dan de alta comercios — no un error.
 */
export async function loadSigningMaterial(
  db: Db,
  passTypeIdentifier: string,
  encryptionKey: Buffer,
  wwdrCertificatePem: string,
): Promise<PassSigningMaterial | null> {
  const found = await rows<{
    certificate_pem: string;
    private_key_ciphertext: Buffer;
    private_key_nonce: Buffer;
    private_key_tag: Buffer;
  }>(
    db.drizzle,
    sql`SELECT certificate_pem, private_key_ciphertext, private_key_nonce, private_key_tag
        FROM pass_certificate WHERE pass_type_identifier = ${passTypeIdentifier}`,
  );

  const row = found[0];
  if (!row) return null;

  return {
    passTypeIdentifier,
    certificatePem: row.certificate_pem,
    privateKeyPem: open(
      {
        ciphertext: Buffer.from(row.private_key_ciphertext),
        nonce: Buffer.from(row.private_key_nonce),
        tag: Buffer.from(row.private_key_tag),
      },
      encryptionKey,
    ),
    wwdrCertificatePem,
  };
}

/**
 * ¿Este comercio puede firmar pases de Apple?
 *
 * Existe para poder contestar **antes** de entregar un link de descarga. El
 * certificado es por comercio, así que tener Apple configurado en el servidor
 * no dice nada sobre si este comercio en particular puede emitir. Sin esta
 * consulta, la única forma de enterarse de que falta era que el cliente abriera
 * el link en su teléfono y se encontrara con un error — y cuando el link viaja
 * por correo, el botón muerto le queda en la casilla para siempre.
 *
 * Va por `merchant_id` y no por Pass Type ID porque el que pregunta es el
 * producto, que conoce a su comercio y no tiene por qué saber cómo se arma el
 * identificador de Apple.
 */
export async function hasSigningMaterial(db: Db, merchantId: string): Promise<boolean> {
  const found = await rows<{ ok: number }>(
    db.drizzle,
    sql`SELECT 1 AS ok FROM pass_certificate WHERE merchant_id = ${merchantId}`,
  );
  return found.length > 0;
}

export interface CertificateRow {
  merchantId: string;
  merchantName: string;
  slug: string;
  productName: string;
  passTypeIdentifier: string | null;
  expiresAt: Date | null;
}

/**
 * Estado del material de firma de **todos** los comercios, tengan certificado o
 * no.
 *
 * Se listan también los que no tienen: son los que no pueden emitir en iPhone, y
 * un listado que solo muestre los cargados esconde justamente el problema.
 */
export async function certificateStatus(db: Db): Promise<CertificateRow[]> {
  const found = await rows<{
    merchant_id: string;
    merchant_name: string;
    slug: string;
    product_name: string;
    pass_type_identifier: string | null;
    expires_at: Date | null;
  }>(
    db.drizzle,
    sql`SELECT m.id AS merchant_id, m.display_name AS merchant_name, m.slug,
               p.name AS product_name,
               c.pass_type_identifier, c.expires_at
        FROM merchant m
        JOIN product p ON p.id = m.product_id
        LEFT JOIN pass_certificate c ON c.merchant_id = m.id
        ORDER BY c.expires_at NULLS FIRST, p.name, m.display_name`,
  );

  return found.map((r) => ({
    merchantId: r.merchant_id,
    merchantName: r.merchant_name,
    slug: r.slug,
    productName: r.product_name,
    passTypeIdentifier: r.pass_type_identifier,
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
  }));
}

/** Certificados que vencen pronto. Un pase con el certificado vencido no se actualiza. */
export async function expiringCertificates(
  db: Db,
  withinDays: number,
  now: Date = new Date(),
): Promise<{ merchantId: string; passTypeIdentifier: string; expiresAt: Date }[]> {
  const limit = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

  const found = await rows<{
    merchant_id: string;
    pass_type_identifier: string;
    expires_at: Date;
  }>(
    db.drizzle,
    sql`SELECT merchant_id, pass_type_identifier, expires_at FROM pass_certificate
        WHERE expires_at < ${limit.toISOString()} ORDER BY expires_at`,
  );

  return found.map((r) => ({
    merchantId: r.merchant_id,
    passTypeIdentifier: r.pass_type_identifier,
    expiresAt: new Date(r.expires_at),
  }));
}
