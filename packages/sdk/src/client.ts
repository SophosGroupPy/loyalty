/**
 * Cliente de la API de Sophos Loyalty.
 *
 * ⚠️ **Solo del lado del servidor.** Este cliente lleva el `clientSecret` de tu
 * producto, y ese secreto da acceso a la base de clientes de **todos** tus
 * comercios. Si termina en un bundle de navegador o en una app móvil, cualquiera
 * puede extraerlo. Llamá desde tu backend y exponé a tu front lo que necesite.
 */

import type {
  EnrollInput,
  IngestEventInput,
  IngestEventResult,
  MembershipRef,
  MembershipView,
  RedeemInput,
  RedeemResult,
} from "./types.js";

export class LoyaltyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "LoyaltyError";
  }
}

export interface LoyaltyClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Inyectable para tests. Por defecto el `fetch` global. */
  fetch?: typeof fetch;
  /** Timeout por request, en ms. Por defecto 10s. */
  timeoutMs?: number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

export class LoyaltyClient {
  private token: CachedToken | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LoyaltyClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  // -------------------------------------------------------------------------

  private async accessToken(force = false): Promise<string> {
    // Margen de 60 s: un token que vence en el viaje de ida produciría un 401
    // espurio en el peor momento, que es durante una venta.
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }

    const response = await this.fetchImpl(`${this.options.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }),
    });

    if (!response.ok) {
      throw new LoyaltyError(
        response.status,
        "auth_failed",
        "Loyalty rechazó las credenciales del producto.",
        await response.text(),
      );
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };

    return this.token.value;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    retriedAfter401 = false,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Un 401 puede ser un token vencido antes de lo previsto (por ejemplo si
    // rotaron la clave de firma). Se reintenta una sola vez con token fresco;
    // si vuelve a fallar, es un problema de credenciales y hay que avisarlo.
    if (response.status === 401 && !retriedAfter401) {
      this.token = null;
      await this.accessToken(true);
      return this.request<T>(method, path, body, true);
    }

    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (!response.ok) {
      throw new LoyaltyError(
        response.status,
        String(parsed.error ?? "unknown"),
        String(parsed.message ?? `Loyalty respondió ${response.status}`),
        parsed,
      );
    }

    return parsed as T;
  }

  // -------------------------------------------------------------------------
  // Operaciones
  // -------------------------------------------------------------------------

  /**
   * Registra un evento de negocio y acumula lo que corresponda.
   *
   * Es idempotente por `idempotencyKey`: reintentar con la misma clave devuelve
   * el resultado original con `duplicate: true` en vez de acumular de nuevo.
   */
  ingestEvent(input: IngestEventInput): Promise<IngestEventResult> {
    return this.request<IngestEventResult>("POST", "/v1/events", input);
  }

  /**
   * Busca a un cliente para mostrarlo en el POS.
   *
   * Devuelve `availableRewards`, que es lo que el cajero tiene que ver: si el
   * cliente puede canjear algo, es el momento en que va a hacerlo.
   */
  async lookupMembership(
    merchant: string,
    ref: MembershipRef,
  ): Promise<MembershipView | null> {
    const params = new URLSearchParams({ merchant });
    if (ref.phone) params.set("phone", ref.phone);
    if (ref.serial) params.set("serial", ref.serial);
    if (ref.id) params.set("id", ref.id);

    try {
      return await this.request<MembershipView>("GET", `/v1/memberships/lookup?${params}`);
    } catch (error) {
      // "No tiene tarjeta" es un resultado esperable en el POS, no una falla:
      // la mayoría de los clientes de un comercio nuevo todavía no se sumaron.
      if (error instanceof LoyaltyError && error.status === 404) return null;
      throw error;
    }
  }

  /** Da de alta una tarjeta desde el POS. */
  enroll(input: EnrollInput): Promise<{ membershipId: string; serialNumber: string }> {
    return this.request("POST", "/v1/memberships", input);
  }

  /** Canjea un beneficio. Falla con `insufficient_balance` si no alcanza. */
  async redeem(input: RedeemInput): Promise<RedeemResult> {
    try {
      return await this.request<RedeemResult>("POST", "/v1/redemptions", input);
    } catch (error) {
      if (error instanceof LoyaltyError && (error.status === 409 || error.status === 404)) {
        return { ok: false, reason: error.code as RedeemResult["reason"] };
      }
      throw error;
    }
  }

  /** Emite la tarjeta en la wallet y devuelve el link para guardarla. */
  issuePass(
    merchant: string,
    membership: MembershipRef,
  ): Promise<{ saveUrl: string; classRegistered: boolean }> {
    return this.request("POST", "/v1/passes", { merchant, membership });
  }
}
