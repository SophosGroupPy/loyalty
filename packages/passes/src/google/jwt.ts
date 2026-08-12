/**
 * Firma de tokens contra Google: el link de guardado y el access token de la API.
 *
 * Los dos usan la clave privada de la service account con RS256, pero son
 * tokens distintos y no hay que confundirlos:
 * - El **save link** lo consume el teléfono del cliente y lleva el pase adentro.
 * - El **access token** lo usa el servidor para hablar con la API REST.
 */

import { SignJWT, importPKCS8 } from "jose";

import { GOOGLE_TOKEN_URL, SAVE_LINK_BASE, WALLET_SCOPE } from "./enums.js";
import type { GoogleLoyaltyClass, GoogleLoyaltyObject, GoogleWalletConfig } from "./types.js";

/**
 * Las claves de service account vienen del JSON de GCP con `\n` escapados.
 * Pegarlas en una variable de entorno sin desescapar es el error más común, y
 * falla con un mensaje de PEM inválido que no dice nada.
 */
function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}

async function signingKey(config: GoogleWalletConfig) {
  return importPKCS8(normalizePem(config.privateKeyPem), "RS256");
}

export interface SaveLinkInput {
  object: GoogleLoyaltyObject;
  /**
   * Clase a crear junto con el objeto, para que el primer guardado no dependa de
   * que la clase ya exista en Google.
   */
  loyaltyClass?: GoogleLoyaltyClass;
}

/**
 * Genera el link de "Add to Google Wallet".
 *
 * El pase viaja firmado dentro del propio link, así que no hace falta llamar a
 * la API para emitir: alcanza con que el cliente lo abra en su Android.
 */
export async function buildSaveLink(
  config: GoogleWalletConfig,
  input: SaveLinkInput,
): Promise<string> {
  const payload: Record<string, unknown> = {
    loyaltyObjects: [input.object],
  };
  if (input.loyaltyClass) payload.loyaltyClasses = [input.loyaltyClass];

  const token = await new SignJWT({
    iss: config.serviceAccountEmail,
    aud: "google",
    typ: "savetowallet",
    // Dominios autorizados a mostrar el botón. Google rechaza el guardado si la
    // página que lo sirve no está acá.
    origins: config.origins,
    payload,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt()
    .sign(await signingKey(config));

  return SAVE_LINK_BASE + token;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * Obtiene un access token para la API REST, con el flujo JWT-bearer de service
 * account (OAuth2 de dos patas: no hay usuario que consienta).
 *
 * Cachea el token hasta poco antes de que venza: dura una hora y volver a
 * firmarlo en cada request es puro desperdicio de CPU.
 */
export function createTokenProvider(
  config: GoogleWalletConfig,
  fetchImpl: typeof fetch = fetch,
): () => Promise<string> {
  let cached: CachedToken | null = null;

  return async function accessToken(): Promise<string> {
    // Margen de 60 s para no usar un token que vence en el viaje de ida.
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

    const assertion = await new SignJWT({ scope: WALLET_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(config.serviceAccountEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(await signingKey(config));

    const response = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Google rechazó las credenciales de la service account (${response.status}): ${await response.text()}`,
      );
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    cached = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };

    return cached.value;
  };
}
