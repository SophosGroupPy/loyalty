/**
 * Cliente REST de Google Wallet.
 *
 * `fetch` es inyectable para poder testear todo el cliente sin red ni
 * credenciales: los tests le pasan un doble que registra las llamadas.
 */

import {
  MESSAGE_TYPE_TEXT,
  MESSAGE_TYPE_TEXT_AND_NOTIFY,
  NOTIFY_PREFERENCE_ON_UPDATE,
  WALLET_API_BASE,
} from "./enums.js";
import { createTokenProvider } from "./jwt.js";
import type {
  GoogleLoyaltyClass,
  GoogleLoyaltyObject,
  GoogleWalletConfig,
  PassMessage,
} from "./types.js";

export class GoogleWalletError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    operation: string,
  ) {
    super(`Google Wallet rechazó ${operation} (HTTP ${status}): ${body}`);
    this.name = "GoogleWalletError";
  }
}

export interface GoogleWalletClient {
  upsertClass(loyaltyClass: GoogleLoyaltyClass): Promise<void>;
  upsertObject(object: GoogleLoyaltyObject): Promise<void>;
  /** Actualiza el saldo. Es el camino caliente: corre tras cada asiento. */
  syncBalance(input: {
    objectId: string;
    balance: number;
    balanceLabel: string;
    notify: boolean;
  }): Promise<void>;
  addMessage(objectId: string, message: PassMessage): Promise<void>;
}

export function createGoogleWalletClient(
  config: GoogleWalletConfig,
  fetchImpl: typeof fetch = fetch,
): GoogleWalletClient {
  const accessToken = createTokenProvider(config, fetchImpl);

  async function request(
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    body?: unknown,
    operation = `${method} ${path}`,
  ): Promise<Response> {
    const response = await fetchImpl(`${WALLET_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok && response.status !== 409) {
      throw new GoogleWalletError(response.status, await response.text(), operation);
    }

    return response;
  }

  /**
   * Crea el recurso y, si Google responde 409 porque ya existe, lo actualiza.
   *
   * Se intenta crear primero a propósito: la alternativa (consultar y después
   * decidir) cuesta dos requests siempre, y la mayoría de las llamadas de alta
   * son creaciones.
   */
  async function upsert(resource: "loyaltyClass" | "loyaltyObject", payload: { id: string }) {
    const created = await request("POST", `/${resource}`, payload, `crear ${resource}`);
    if (created.status === 409) {
      await request(
        "PATCH",
        `/${resource}/${encodeURIComponent(payload.id)}`,
        payload,
        `actualizar ${resource}`,
      );
    }
  }

  return {
    async upsertClass(loyaltyClass) {
      await upsert("loyaltyClass", loyaltyClass);
    },

    async upsertObject(object) {
      await upsert("loyaltyObject", object);
    },

    async syncBalance({ objectId, balance, balanceLabel, notify }) {
      // Solo `loyaltyPoints.balance` y `secondaryLoyaltyPoints.balance` disparan
      // notificación en Google. Un cambio de nivel por sí solo no notifica: para
      // avisar "subiste a Oro" hay que mandarlo por `addMessage`.
      await request(
        "PATCH",
        `/loyaltyObject/${encodeURIComponent(objectId)}`,
        {
          id: objectId,
          loyaltyPoints: { label: balanceLabel, balance: { int: balance } },
          // Transient: va en cada request que deba notificar, no se configura
          // una sola vez.
          ...(notify ? { notifyPreference: NOTIFY_PREFERENCE_ON_UPDATE } : {}),
        },
        "sincronizar saldo",
      );
    },

    async addMessage(objectId, message) {
      await request(
        "POST",
        `/loyaltyObject/${encodeURIComponent(objectId)}/addMessage`,
        {
          message: {
            id: message.id,
            header: message.header,
            body: message.body,
            messageType: message.notify
              ? MESSAGE_TYPE_TEXT_AND_NOTIFY
              : MESSAGE_TYPE_TEXT,
          },
        },
        "agregar mensaje",
      );
    },
  };
}
