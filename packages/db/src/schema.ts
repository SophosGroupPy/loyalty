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
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
  notes: text("notes"),
  tags: text("tags").array().notNull(),
  birthdate: date("birthdate"),
  balance: integer("balance").notNull(),
  tier: text("tier"),
  status: text("status").$type<"active" | "opted_out" | "deleted">().notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
});

export const event = pgTable("event", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull(),
  merchantId: uuid("merchant_id").notNull(),
  membershipId: uuid("membership_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
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
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schema = {
  product,
  merchant,
  program,
  person,
  membership,
  event,
  reward,
  ledgerEntry,
  redemption,
};
