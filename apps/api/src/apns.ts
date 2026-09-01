/**
 * Envío de push a Apple para avisar que un pase cambió.
 *
 * El push va **con payload vacío** y el cliente no lo ve: no es una
 * notificación, es un golpecito para que el teléfono vuelva a pedir el pase.
 * Lo que el cliente ve es la tarjeta ya actualizada, y el aviso visible —si
 * corresponde— sale del `changeMessage` del campo de novedades, no de acá.
 *
 * La autenticación es por certificado de cliente TLS con el mismo certificado
 * del Pass Type ID que firma los pases. Por eso hay una conexión por comercio:
 * cada uno tiene el suyo.
 *
 * **Lo que está verificado y lo que no.** La lógica de esta capa está cubierta
 * por tests: qué tokens se dan de baja, qué pasa cuando Apple rechaza, cómo se
 * agrupa por pase. El transporte contra `api.push.apple.com` **no se probó
 * nunca**: hace falta un push token real, que solo existe cuando un iPhone logra
 * registrarse contra el web service, y eso necesita el deploy.
 */

import { connect, constants, type ClientHttp2Session } from "node:http2";

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";
import type { PassSigningMaterial } from "@sophos/passes";

import { dropPushToken, loadSigningMaterial } from "./apple.js";

export const APNS_PRODUCTION = "https://api.push.apple.com";
export const APNS_SANDBOX = "https://api.sandbox.push.apple.com";

/**
 * `apns-push-type` para actualizaciones de pase.
 *
 * **Sin verificar contra la API real.** La documentación de Apple describe el
 * header para notificaciones de app y no dice qué corresponde a un pase; las
 * implementaciones históricas lo omiten y funcionan. Se deja en un solo lugar,
 * como se hizo con los literales de Google: cuando se pruebe con un teléfono de
 * verdad, si hay que cambiarlo se cambia acá y en ningún otro lado.
 *
 * `null` significa no mandar el header.
 */
export const APNS_PUSH_TYPE: string | null = null;

/** Prioridad 10: el saldo cambió y el cliente lo está mirando. */
const APNS_PRIORITY = "10";

export type PushResult =
  | { status: "sent" }
  /** El pase ya no está en ese dispositivo. Hay que borrar el registro. */
  | { status: "unregistered" }
  | { status: "failed"; reason: string };

export interface ApnsClient {
  push(
    passTypeIdentifier: string,
    pushToken: string,
    material: PassSigningMaterial,
  ): Promise<PushResult>;
  close(): Promise<void>;
}

/**
 * Cliente real sobre HTTP/2.
 *
 * Se cachea una sesión por Pass Type ID. Abrir una conexión TLS por push es lo
 * que hace que Apple empiece a limitar al emisor — y el emisor es uno solo para
 * todo el ecosistema, así que el castigo lo pagarían todos los comercios.
 */
export function createApnsClient(host: string = APNS_PRODUCTION): ApnsClient {
  const sessions = new Map<string, ClientHttp2Session>();

  function sessionFor(material: PassSigningMaterial): ClientHttp2Session {
    const existing = sessions.get(material.passTypeIdentifier);
    if (existing && !existing.closed && !existing.destroyed) return existing;

    const session = connect(host, {
      key: material.privateKeyPem,
      cert: material.certificatePem,
    });
    // Sin esto, un error de red no atendido tumba el proceso entero.
    session.on("error", () => sessions.delete(material.passTypeIdentifier));
    session.on("close", () => sessions.delete(material.passTypeIdentifier));

    sessions.set(material.passTypeIdentifier, session);
    return session;
  }

  return {
    async push(passTypeIdentifier, pushToken, material) {
      return new Promise<PushResult>((resolve) => {
        let session: ClientHttp2Session;
        try {
          session = sessionFor(material);
        } catch (error) {
          resolve({ status: "failed", reason: messageOf(error) });
          return;
        }

        const request = session.request({
          [constants.HTTP2_HEADER_METHOD]: "POST",
          [constants.HTTP2_HEADER_PATH]: `/3/device/${pushToken}`,
          [constants.HTTP2_HEADER_CONTENT_TYPE]: "application/json",
          "apns-topic": passTypeIdentifier,
          "apns-priority": APNS_PRIORITY,
          ...(APNS_PUSH_TYPE ? { "apns-push-type": APNS_PUSH_TYPE } : {}),
        });

        let status = 0;
        let body = "";

        request.on("response", (headers) => {
          status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
        });
        request.on("data", (chunk) => (body += chunk));
        request.on("error", (error) => resolve({ status: "failed", reason: messageOf(error) }));

        request.on("end", () => {
          if (status === 200) return resolve({ status: "sent" });

          // 410 y BadDeviceToken significan lo mismo: el pase ya no está ahí.
          // Insistir contra un token muerto es lo que dispara el throttling.
          const reason = parseReason(body);
          if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
            return resolve({ status: "unregistered" });
          }

          resolve({ status: "failed", reason: reason ?? `HTTP ${status}` });
        });

        // El payload vacío es el punto: no lleva contenido, solo despierta al
        // dispositivo para que venga a buscar el pase.
        request.end("{}");
      });
    },

    async close() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  };
}

function parseReason(body: string): string | null {
  try {
    return (JSON.parse(body) as { reason?: string }).reason ?? null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------

export interface PushSummary {
  sent: number;
  /** Registros borrados porque el pase ya no estaba en el dispositivo. */
  dropped: number;
  failed: number;
  /** `true` si el comercio todavía no tiene certificado cargado. */
  skipped?: boolean;
}

/**
 * Avisa a todos los dispositivos que tienen este pase.
 *
 * Los tokens que Apple rechaza por inexistentes se borran en el momento. Dejar
 * basura acumulada haría que cada aviso gastara intentos contra dispositivos
 * que ya no existen.
 */
export async function pushPassUpdate(
  db: Db,
  membershipId: string,
  client: ApnsClient,
  encryptionKey: Buffer,
  wwdrCertificatePem: string,
): Promise<PushSummary> {
  const registrations = await rows<{ pass_type_identifier: string; push_token: string }>(
    db.drizzle,
    sql`SELECT pass_type_identifier, push_token FROM apple_device_registration
        WHERE membership_id = ${membershipId}`,
  );

  const summary: PushSummary = { sent: 0, dropped: 0, failed: 0 };
  if (registrations.length === 0) return summary;

  // El material se carga una vez por Pass Type ID, no una por dispositivo: la
  // misma persona puede tener el pase en el iPhone y en el Apple Watch.
  const materials = new Map<string, PassSigningMaterial | null>();

  for (const registration of registrations) {
    const passType = registration.pass_type_identifier;

    if (!materials.has(passType)) {
      materials.set(
        passType,
        await loadSigningMaterial(db, passType, encryptionKey, wwdrCertificatePem),
      );
    }

    const material = materials.get(passType);
    if (!material) {
      summary.skipped = true;
      continue;
    }

    const result = await client.push(passType, registration.push_token, material);

    if (result.status === "sent") summary.sent += 1;
    else if (result.status === "unregistered") {
      await dropPushToken(db, registration.push_token);
      summary.dropped += 1;
    } else summary.failed += 1;
  }

  return summary;
}
