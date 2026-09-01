/**
 * Tipos del contrato de integración.
 *
 * Es lo que ElMenu y Noctu importan para hablar con loyalty. Cambiar algo acá
 * rompe integraciones ajenas, así que se agrega antes de modificar.
 */

/** Eventos de negocio que los productos emiten hacia loyalty. */
export type BusinessEventType =
  | "order.paid"
  | "ticket.validated"
  | "table.reserved"
  | "invoice.issued";

/** Eventos que loyalty emite hacia los productos. */
export type WebhookEventType =
  | "membership.created"
  | "membership.balance_changed"
  | "membership.tier_changed"
  | "reward.available"
  | "redemption.completed";

/** Cómo se identifica a un cliente. Alcanza con uno de los tres. */
export interface MembershipRef {
  id?: string;
  serial?: string;
  phone?: string;
}

export interface IngestEventInput {
  /** `external_id` del comercio dentro de tu producto. */
  merchant: string;
  /**
   * Clave de idempotencia: usá **el id del pedido en tu sistema**.
   *
   * Reintentar con la misma clave es seguro y no acumula dos veces. Un POS con
   * mala señal reintenta solo, así que esto no es opcional en la práctica.
   */
  idempotencyKey: string;
  type: BusinessEventType;
  membership: MembershipRef;
  /** Monto en la unidad mínima de la moneda. Para guaraníes, el guaraní entero. */
  amount?: number;
  occurredAt?: string;
}

export interface IngestEventResult {
  eventId: string;
  membershipId: string;
  /** Cuánto acumuló. Cero si ninguna regla aplicó o un tope lo recortó. */
  amount: number;
  balance: number;
  unit: "points" | "stamps";
  tier: string | null;
  /** `true` si esta clave ya se había procesado. El saldo es el original. */
  duplicate: boolean;
}

export interface AvailableReward {
  id: string;
  name: string;
  cost: number;
}

export interface MembershipView {
  membershipId: string;
  serialNumber: string;
  displayName: string | null;
  balance: number;
  unit: "points" | "stamps";
  tier: string | null;
  /** Lo que el cajero tiene que ver: qué puede canjear este cliente ahora. */
  availableRewards: AvailableReward[];
}

export interface EnrollInput {
  merchant: string;
  phone: string;
  displayName?: string;
  /**
   * Solo `true` si tu producto ya verificó el celular. Si no lo verificaste,
   * mandá al cliente a la landing de alta, que hace el OTP.
   */
  phoneVerified?: boolean;
}

export interface RedeemInput {
  merchant: string;
  rewardId: string;
  membership: MembershipRef;
  /** Quién del staff autorizó el canje. Queda en el registro de auditoría. */
  redeemedBy: string;
}

export interface RedeemResult {
  ok: boolean;
  redemptionId?: string;
  balance?: number;
  reason?: "insufficient_balance" | "reward_not_found" | "membership_not_found";
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export interface WebhookEnvelope<T = Record<string, unknown>> {
  /** Estable entre reintentos. Usalo para deduplicar. */
  eventId: string;
  type: WebhookEventType;
  /** `external_id` del comercio dentro de tu producto. */
  merchant: string;
  occurredAt: string;
  data: T;
}

export interface RewardAvailableData {
  membershipId: string;
  serialNumber: string;
  phone: string | null;
  balance: number;
  rewards: AvailableReward[];
}

export interface BalanceChangedData {
  membershipId: string;
  serialNumber: string;
  balance: number;
  delta: number;
  unit: "points" | "stamps";
}

export interface TierChangedData {
  membershipId: string;
  serialNumber: string;
  from: string | null;
  to: string | null;
}

export interface RedemptionCompletedData {
  membershipId: string;
  redemptionId: string;
  rewardId: string;
  rewardName: string;
  cost: number;
  balance: number;
  redeemedBy: string;
}

export interface MembershipCreatedData {
  membershipId: string;
  serialNumber: string;
  phone: string | null;
  displayName: string | null;
  /** `true` si la persona ya existía en el ecosistema: el alta de un toque. */
  personExisted: boolean;
}

// ---------------------------------------------------------------------------
// Activación del módulo
// ---------------------------------------------------------------------------

export interface UpsertMerchantInput {
  /** El id del comercio **en tu producto**. Es la clave de identidad. */
  externalId: string;
  /** Identificador legible, para URLs y para el Pass Type ID de Apple. */
  slug: string;
  /** Razón social. Va en la atribución del dorso del pase. */
  legalName: string;
  /** Nombre comercial. Es lo que el cliente ve en la tarjeta. */
  displayName: string;
  /** IANA, por ejemplo "America/Asuncion". Por defecto, el de Paraguay. */
  timezone?: string;
}

export interface ConfigureProgramInput {
  /** `externalId` del comercio. */
  merchant: string;
  kind: "points" | "stamps";
  /** Reemplaza la configuración entera. Ver la advertencia en `configureProgram`. */
  config: Record<string, unknown>;
}

export interface EmbedTokenInput {
  /** `externalId` del comercio. */
  merchant: string;
  /** Quién abrió la consola, para el audit log. Opcional. */
  staffId?: string;
}
