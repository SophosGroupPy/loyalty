/**
 * Definición Drizzle del esquema, para consultas tipadas.
 *
 * El DDL de verdad vive en `migrations/0001_init.sql` — ahí están los CHECK, los
 * índices parciales y el trigger de append-only, que son las garantías que
 * importan. Este archivo es la vista tipada de esas mismas tablas.
 *
 * `schema.test.ts` compara ambos y falla si se desincronizan.
 */

import {
  customType,
  date,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Drizzle no trae `bytea`; lo usamos para los secretos cifrados. */
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

import type { CardDesign } from "@sophos/passes";
import type { EarnTrace, ProgramConfig } from "@sophos/rules";

export const product = pgTable("product", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  clientId: text("client_id").notNull(),
  clientSecretHash: text("client_secret_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const merchant = pgTable("merchant", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull(),
  externalId: text("external_id").notNull(),
  slug: text("slug").notNull(),
  legalName: text("legal_name").notNull(),
  displayName: text("display_name").notNull(),
  timezone: text("timezone").notNull(),
  design: jsonb("design").$type<CardDesign>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const merchantLocation = pgTable("merchant_location", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").notNull(),
  label: text("label").notNull(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  relevantText: text("relevant_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const passInstance = pgTable("pass_instance", {
  id: uuid("id").primaryKey().defaultRandom(),
  membershipId: uuid("membership_id").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  platform: text("platform").$type<"google" | "apple" | "web">().notNull(),
  externalId: text("external_id").notNull(),
  state: text("state").$type<"active" | "revoked">().notNull(),
  lastSyncedBalance: integer("last_synced_balance"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastError: text("last_error"),
  // Última novedad mostrada en el pase de Apple. Su cambio de valor es lo que
  // dispara el aviso visible en iPhone (el campo de novedades lleva
  // `changeMessage`). Ver `migrations/0013_pass_news.sql`.
  news: text("news"),
  contentUpdatedAt: timestamp("content_updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Dispositivos Apple registrados contra un pase.
 *
 * Ver `migrations/0007_apple.sql`: Apple no deja empujar contenido a un pase,
 * así que el teléfono se registra y después se le manda un push vacío para que
 * venga a buscar la versión nueva.
 */
export const appleDeviceRegistration = pgTable("apple_device_registration", {
  id: uuid("id").primaryKey().defaultRandom(),
  deviceLibraryIdentifier: text("device_library_identifier").notNull(),
  passTypeIdentifier: text("pass_type_identifier").notNull(),
  serialNumber: text("serial_number").notNull(),
  pushToken: text("push_token").notNull(),
  membershipId: uuid("membership_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Certificado de Pass Type ID por comercio. Ver `migrations/0008_*.sql`.
 *
 * La clave privada va cifrada; el certificado no, porque es público y viaja
 * dentro de cada `.pkpass` que se emite.
 */
/** Coordinación de los trabajos periódicos. Ver `migrations/0009_job_run.sql`. */
export const jobRun = pgTable("job_run", {
  name: text("name").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  lastHost: text("last_host"),
  lastResult: jsonb("last_result"),
});

export const passCertificate = pgTable("pass_certificate", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").notNull(),
  passTypeIdentifier: text("pass_type_identifier").notNull(),
  certificatePem: text("certificate_pem").notNull(),
  privateKeyCiphertext: bytea("private_key_ciphertext").notNull(),
  privateKeyNonce: bytea("private_key_nonce").notNull(),
  privateKeyTag: bytea("private_key_tag").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const program = pgTable("program", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").notNull(),
  kind: text("kind").$type<"points" | "stamps">().notNull(),
  config: jsonb("config").$type<ProgramConfig>().notNull(),
  status: text("status").$type<"active" | "paused">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const person = pgTable("person", {
  id: uuid("id").primaryKey().defaultRandom(),
  phoneE164: text("phone_e164").notNull(),
  phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
  firstName: text("first_name"),
  consentVersion: text("consent_version").notNull(),
  consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const membership = pgTable("membership", {
  id: uuid("id").primaryKey().defaultRandom(),
  personId: uuid("person_id").notNull(),
  programId: uuid("program_id").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  serialNumber: text("serial_number").notNull(),
  displayName: text("display_name"),
  email: text("email"),
  notes: text("notes"),
  tags: text("tags").array().notNull(),
  birthdate: date("birthdate"),
  balance: integer("balance").notNull(),
  tier: text("tier"),
  status: text("status").$type<"active" | "opted_out" | "deleted">().notNull(),
  /** Canales de los que el cliente se dio de baja, sin dejar el programa. */
  notificationOptout: text("notification_optout").array().notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
});

export const otpChallenge = pgTable("otp_challenge", {
  id: uuid("id").primaryKey().defaultRandom(),
  phoneE164: text("phone_e164").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaign = pgTable("campaign", {
  id: uuid("id").primaryKey().defaultRandom(),
  merchantId: uuid("merchant_id").notNull(),
  header: text("header").notNull(),
  body: text("body").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notification = pgTable("notification", {
  id: uuid("id").primaryKey().defaultRandom(),
  membershipId: uuid("membership_id").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  channel: text("channel").$type<"wallet" | "whatsapp" | "webpush">().notNull(),
  kind: text("kind").notNull(),
  priority: integer("priority").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  header: text("header"),
  body: text("body"),
  campaignId: uuid("campaign_id"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /**
   * Entrega efectiva a Google. Es lo que cuenta el cupo diario: el tope de
   * 3/24 h es de Google, y Apple no debe gastarlo.
   */
  googleSentAt: timestamp("google_sent_at", { withTimezone: true }),
  suppressedReason: text("suppressed_reason"),
  supersededBy: uuid("superseded_by"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const event = pgTable("event", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  membershipId: uuid("membership_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  /**
   * Monto de la transacción, en la unidad mínima de la moneda.
   *
   * Se persiste aunque el motor ya lo haya consumido: es lo que permite derivar
   * visitas, gasto y ticket promedio sin importar el CRM del producto. Es
   * `NULL` en eventos que no son una compra, como validar una entrada.
   */
  amount: integer("amount"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  result: jsonb("result").$type<EventResult>(),
});

/** Lo que quedó registrado de la evaluación, haya o no generado asiento. */
export interface EventResult {
  amount: number;
  unit: "points" | "stamps";
  trace: EarnTrace;
  ledgerEntryId: string | null;
  /** Por qué no se generó asiento, cuando corresponda. */
  skipped?: "no_membership" | "zero_amount" | "program_paused";
}

export const reward = pgTable("reward", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  name: text("name").notNull(),
  cost: integer("cost").notNull(),
  terms: text("terms"),
  /** Nivel mínimo para canjear. Null = lo puede canjear cualquiera. */
  minTier: text("min_tier"),
  /** Qué es: un producto del menú, un porcentaje o un monto fijo. */
  kind: text("kind").$type<"free_item" | "percentage" | "fixed">().notNull(),
  /** El 20 de "20 %", o los guaraníes del monto fijo. Null en `free_item`. */
  value: integer("value"),
  /** El producto en el sistema del comercio, cuando el beneficio es un producto. */
  externalProductId: text("external_product_id"),
  /**
   * Cómo llega a manos del cliente.
   *
   * `ticket` descuenta de la venta —entra en el arqueo y en la factura—;
   * `aparte` solo registra el canje y no toca los totales. Es decisión del
   * comercio y no del tipo: el mismo café gratis puede ir de las dos formas.
   */
  entrega: text("entrega").$type<"aparte" | "ticket">().notNull(),
  status: text("status").$type<"active" | "archived">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEntry = pgTable("ledger_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  membershipId: uuid("membership_id").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  kind: text("kind").$type<"earn" | "redeem" | "adjust" | "expire">().notNull(),
  amount: integer("amount").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  businessDay: date("business_day").notNull(),
  sourceEventId: uuid("source_event_id"),
  reason: text("reason"),
  trace: jsonb("trace").$type<EarnTrace>(),
  actor: text("actor").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const redemption = pgTable("redemption", {
  id: uuid("id").primaryKey().defaultRandom(),
  membershipId: uuid("membership_id").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  rewardId: uuid("reward_id").notNull(),
  ledgerEntryId: uuid("ledger_entry_id").notNull(),
  redeemedBy: text("redeemed_by").notNull(),
  /** El pedido del comercio contra el que se usó. Null si se entregó suelto. */
  externalOrderId: text("external_order_id"),
  /** Cuánta plata representó, para poder cruzar canjes contra ventas. */
  discountAmount: integer("discount_amount"),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  product,
  merchant,
  merchantLocation,
  passInstance,
  program,
  person,
  membership,
  event,
  reward,
  ledgerEntry,
  redemption,
  campaign,
  notification,
  otpChallenge,
};
