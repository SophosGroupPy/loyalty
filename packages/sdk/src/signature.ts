/**
 * Firma y verificación de webhooks.
 *
 * **Este módulo lo usan los dos lados**: Sophos para firmar cada entrega y el
 * producto para verificarla. Que sea el mismo código no es comodidad — es lo
 * que garantiza que firmante y verificador no puedan discrepar. La mitad de los
 * bugs de integración de webhooks salen de dos implementaciones que difieren en
 * un detalle (el separador, el encoding, si se incluye el timestamp).
 *
 * Formato de la cabecera, al estilo de Stripe:
 *
 *     X-Sophos-Signature: t=1786636000,v1=3a7bd3e2360a...
 *
 * Lo firmado es `${timestamp}.${cuerpo crudo}`. El timestamp va adentro de la
 * firma a propósito: si fuera solo una cabecera aparte, cualquiera podría
 * cambiarlo y reusar una entrega vieja.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-sophos-signature";

/**
 * Ventana de tolerancia del timestamp, en segundos.
 *
 * Acota el replay: una entrega capturada hoy no sirve mañana. Cinco minutos
 * deja margen para relojes desfasados sin abrir una ventana grande.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Arma el valor de la cabecera para un cuerpo ya serializado. */
export function signPayload(
  body: string,
  secret: string,
  timestampSeconds: number,
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`)
    .digest("hex");

  return `t=${timestampSeconds},v1=${signature}`;
}

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: "malformed_header" | "expired" | "mismatch" };

/**
 * Verifica una entrega recibida.
 *
 * `body` tiene que ser el **cuerpo crudo**, tal como llegó. Si se parsea a
 * objeto y se vuelve a serializar, el orden de las claves o el espaciado pueden
 * cambiar y la firma deja de coincidir — es el error más común al integrar.
 */
export function verifySignature(
  body: string,
  header: string | undefined,
  secret: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {},
): VerifyResult {
  if (!header) return { valid: false, reason: "malformed_header" };

  const parts = new Map(
    header.split(",").map((part) => {
      const [key, value] = part.trim().split("=", 2);
      return [key ?? "", value ?? ""] as const;
    }),
  );

  const timestamp = Number(parts.get("t"));
  const received = parts.get("v1");
  if (!Number.isFinite(timestamp) || !received) {
    return { valid: false, reason: "malformed_header" };
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return { valid: false, reason: "expired" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  // La comparación es en tiempo constante: comparar con === filtraría, por el
  // tiempo de respuesta, cuántos caracteres iniciales acertó un atacante.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return { valid: false, reason: "mismatch" };

  return timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: "mismatch" };
}
