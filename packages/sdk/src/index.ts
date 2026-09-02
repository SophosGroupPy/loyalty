/**
 * `@sophos/loyalty-sdk` — cliente del módulo de fidelidad de Sophos.
 *
 * Lo instalan ElMenu, Noctu y FactuFast para hablar con loyalty desde su
 * backend. Ver el README para el flujo de integración completo.
 */

export { LoyaltyClient, LoyaltyError, type LoyaltyClientOptions } from "./client.js";

export {
  signPayload,
  verifySignature,
  SIGNATURE_HEADER,
  DEFAULT_TOLERANCE_SECONDS,
  type VerifyResult,
} from "./signature.js";

export type {
  ReverseEventResult,
  ConfigureProgramInput,
  EmbedTokenInput,
  UpsertMerchantInput,
  AvailableReward,
  BalanceChangedData,
  BusinessEventType,
  EnrollInput,
  IngestEventInput,
  IngestEventResult,
  MembershipCreatedData,
  MembershipRef,
  MembershipView,
  RedeemInput,
  RedeemResult,
  RedemptionCompletedData,
  RewardAvailableData,
  TierChangedData,
  WebhookEnvelope,
  WebhookEventType,
} from "./types.js";
