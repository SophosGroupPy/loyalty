/**
 * Cliente de la API de Sophos Loyalty.
 *
 * ⚠️ **Solo del lado del servidor.** Este cliente lleva el `clientSecret` de tu
 * producto, y ese secreto da acceso a la base de clientes de **todos** tus
 * comercios. Si termina en un bundle de navegador o en una app móvil, cualquiera
 * puede extraerlo. Llamá desde tu backend y exponé a tu front lo que necesite.
 */

import type {
  ConfigureProgramInput,
  EmbedTokenInput,
  EnrollInput,
  IngestEventInput,
  IngestEventResult,
  MembershipRef,
  MembershipView,
  RedeemInput,
  RedeemResult,
  ReverseEventResult,
  UpsertMerchantInput,
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
   * Deshace la acumulación de un consumo que se anuló, se invitó o no se
   * entregó.
   *
   * Va con la misma `idempotencyKey` del consumo: no hace falta guardar ningún
   * id de loyalty, alcanza con el id del pedido propio.
   *
   * **Si el cliente ya canjeó esos puntos, se descuenta lo que haya.** No se
   * puede des-tomar el café, y dejar el saldo en negativo sería incomprensible
   * para el cliente. La respuesta trae `notRecovered` con lo que no se pudo
   * recuperar: es plata que el comercio entregó por un consumo que no existió,
   * y tiene derecho a saberlo.
   *
   * Es idempotente: reintentar devuelve el primer resultado con
   * `duplicate: true`.
   */
  reverseEvent(input: {
    merchant: string;
    idempotencyKey: string;
    reason?: string;
  }): Promise<ReverseEventResult> {
    return this.request("POST", "/v1/events/reverse", input);
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

  // -------------------------------------------------------------------------
  // Activación del módulo
  //
  // Lo que corre cuando un comercio enciende Fidelización dentro de tu producto.
  // Va una vez por comercio y es idempotente: se puede llamar en cada arranque
  // sin revisar si ya existe.
  // -------------------------------------------------------------------------

  /**
   * Da de alta el comercio, o actualiza sus datos si ya estaba.
   *
   * La clave es `externalId`: el id que ese comercio tiene **en tu producto**.
   * Loyalty no lo interpreta, solo lo usa para reconocerlo, así que reenviar el
   * alta cuando cambia el nombre del local es la forma normal de mantenerlo al
   * día.
   *
   * `legalName` es la razón social y aparece en el dorso del pase, en la
   * atribución que exige el mandato con el que Sophos firma; `displayName` es lo
   * que el cliente ve en la cara de la tarjeta.
   *
   * **El `slug` no se puede cambiar después.** Está adentro del Pass Type ID de
   * Apple y del id de clase de Google: cambiarlo huerfanaría todos los pases ya
   * emitidos. Si mandás uno distinto al del alta, la respuesta trae el guardado
   * y no el que mandaste — comparalos si te importa.
   */
  upsertMerchant(
    input: UpsertMerchantInput,
  ): Promise<{ id: string; externalId: string; slug: string }> {
    return this.request("POST", "/v1/merchants", input);
  }

  /**
   * Crea o reemplaza el programa del comercio.
   *
   * **Reemplaza, no combina.** Mandar solo las reglas nuevas borra el resto de
   * la configuración —topes, vencimiento, horarios— sin avisar. Si el comercio
   * ya configuró cosas desde la consola, esto no se llama de nuevo: se llama una
   * vez al activar, con un preset, y a partir de ahí manda la consola.
   */
  configureProgram(input: ConfigureProgramInput): Promise<{ id: string }> {
    return this.request("PUT", "/v1/programs", input);
  }

  /**
   * Token para embeber la consola del comercio dentro de tu producto.
   *
   * Es lo que hace que el comercio configure todo sin salir de tu UI. Dura una
   * hora y está atado a **ese** comercio: los endpoints de la consola ignoran
   * cualquier `merchant` que venga en el request, así que no hay forma de
   * alcanzar los datos de otro editando la URL.
   *
   * Se pide **desde tu backend**, nunca desde el navegador: el access token de
   * producto no puede salir del servidor.
   */
  createEmbedToken(input: EmbedTokenInput): Promise<{ token: string; expiresIn: number }> {
    return this.request("POST", "/v1/embed-tokens", input);
  }
}
