/**
 * API pública de Sophos Loyalty.
 *
 * Contrato backend a backend: cada producto (ElMenu, Noctu, FactuFast) tiene sus
 * credenciales y opera solo sobre sus comercios. El aislamiento no depende de que
 * cada handler se acuerde de filtrar — pasa por `withMerchant`, que resuelve el
 * comercio siempre dentro del producto que hace el pedido.
 */

import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { rows, type Db } from "@sophos/db";
import type { WebhookEventType } from "@sophos/loyalty-sdk";
import { validateConfig, type ProgramConfig } from "@sophos/rules";

import {
  authenticateProduct,
  issueEmbedToken,
  adminKeyMatches,
  hashSecret,
  issueAdminToken,
  issueToken,
  resolveMerchant,
  verifyAdminToken,
  verifyEmbedToken,
  verifyToken,
  type EmbedClaims,
  type AdminClaims,
  type ResolvedMerchant,
  type TokenClaims,
} from "./auth.js";
import { applyEvent, redeem } from "./ledger.js";
import { enroll, lookup, normalizePhone } from "./memberships.js";
import {
  createConsoleOtpSender,
  startEnrollment,
  verifyEnrollment,
  type OtpSender,
} from "./enrollment.js";
import { campaignReport, dispatchDue, enqueue } from "./notifications/dispatcher.js";
import { CAMPAIGN_BUDGET, DAILY_BUDGET } from "./notifications/policy.js";

/**
 * Avisos que el sistema dispara solo, con el texto que ve el comercio.
 *
 * Deliberadamente no se le habla de "kinds" ni de prioridades internas: se le
 * dice cuándo se manda cada uno y para qué sirve.
 */
const AUTOMATIC_KINDS = [
  {
    id: "balance_changed",
    label: "Sumó puntos",
    description: "Después de cada consumo, con el saldo actualizado.",
  },
  {
    id: "reward_unlocked",
    label: "Desbloqueó un beneficio",
    description: "Cuando cruza el umbral. Es el que más visitas genera.",
  },
  {
    id: "points_expiring",
    label: "Se le vencen puntos",
    description: "Antes del vencimiento. Es el que más clientes dormidos recupera.",
  },
  {
    id: "tier_changed",
    label: "Cambió de nivel",
    description: "Cuando sube o baja de categoría.",
  },
] as const;
import { createConsoleSender, createWalletSender } from "./notifications/senders.js";
import type { NotificationSender } from "./notifications/dispatcher.js";
import { createPassService, type PassService } from "./passes.js";
import { deliverDue, enqueueWebhook, rewardsJustUnlocked } from "./webhooks.js";
import type { CardDesign, GoogleWalletConfig } from "@sophos/passes";

declare module "fastify" {
  interface FastifyRequest {
    claims?: TokenClaims;
    /** Sesión de consola embebida. El comercio sale de acá y de ningún otro lado. */
    embed?: EmbedClaims;
    /** Sesión de back-office de Sophos. Ve todo el ecosistema. */
    admin?: AdminClaims;
  }
}

export interface ServerOptions {
  db: Db;
  signingKey: Uint8Array;
  logger?: boolean;
  /** Sin esto, los endpoints de wallet responden 503 y el resto sigue andando. */
  googleWallet?: GoogleWalletConfig;
  /** Inyectable para testear la capa de pases sin red. */
  fetchImpl?: typeof fetch;
  /** Permite sustituir el servicio completo en los tests. */
  passService?: PassService;
  /**
   * Clave maestra del back-office. Sin ella, `/admin/session` responde 503 y el
   * back-office queda deshabilitado — que es lo correcto en un entorno que no
   * lo necesita.
   */
  adminKey?: string;
  /**
   * Reloj del servidor. Inyectable para que los tests controlen cuándo se
   * agenda un aviso.
   *
   * Sin esto, cualquier test que encole por HTTP y despache con un `now` fijo
   * depende de la hora real de la máquina: funciona hasta que el reloj cruza la
   * fecha del test y falla sin que nadie haya tocado el código.
   */
  now?: () => Date;
  /** Canal de envío. Por defecto: wallet si hay credenciales, consola si no. */
  notificationSender?: NotificationSender;
  /** Envío del OTP. Por defecto imprime por consola, para desarrollo. */
  otpSender?: OtpSender;
}

const EVENT_TYPES = [
  "order.paid",
  "ticket.validated",
  "table.reserved",
  "invoice.issued",
] as const;

export function createServer(opts: ServerOptions): FastifyInstance {
  const { db, signingKey } = opts;
  const app = Fastify({ logger: opts.logger ?? false });

  const passes =
    opts.passService ?? createPassService(db, opts.googleWallet, opts.fetchImpl);

  const clock = opts.now ?? (() => new Date());

  // Sin credenciales de wallet el despachador sigue funcionando entero contra la
  // consola: se puede verificar cupo, prioridad y agrupamiento sin depender de
  // que exista el Issuer.
  const sender =
    opts.notificationSender ??
    (passes.enabled ? createWalletSender(passes) : createConsoleSender());

  // Sin proveedor de WhatsApp o SMS el código se imprime por consola: permite
  // recorrer el alta entera antes de contratar uno.
  const otpSender = opts.otpSender ?? createConsoleOtpSender();

  /**
   * Encola un webhook sin bloquear la respuesta ni poder romperla.
   *
   * Es distinto de `enqueue`, que avisa al **cliente**: esto le avisa al
   * **producto**, para que su POS sepa qué mostrarle al cajero. Igual que con
   * los pases, que ElMenu esté caído no puede convertir una venta registrada en
   * un error.
   */
  function emitWebhook(
    merchantId: string,
    type: WebhookEventType,
    data: Record<string, unknown>,
    productId?: string,
  ): void {
    void enqueueWebhook(db, {
      productId: productId ?? "",
      merchantId,
      type,
      data,
    }).catch((error) => {
      app.log.error({ err: error, type, merchantId }, "no se pudo encolar el webhook");
    });
  }

  /** Datos mínimos de una tarjeta para armar el cuerpo de un webhook. */
  async function membershipBrief(membershipId: string) {
    const found = await rows<{ serial_number: string; phone: string | null }>(
      db.drizzle,
      sql`SELECT m.serial_number, p.phone_e164 AS phone
          FROM membership m JOIN person p ON p.id = m.person_id
          WHERE m.id = ${membershipId}`,
    );
    return found[0] ?? null;
  }

  /**
   * Empuja el saldo al pase sin bloquear la respuesta ni poder romperla.
   *
   * El cliente ya consumió y sus puntos le corresponden: que Google esté caído
   * no puede convertir una acumulación exitosa en un error. El desfasaje queda
   * registrado y lo levanta la reconciliación.
   */
  function syncPassInBackground(membershipId: string): void {
    void passes.syncGooglePass(membershipId).catch((error) => {
      app.log.error({ err: error, membershipId }, "falló la sincronización del pase");
    });
  }

  // --------------------------------------------------------------------------
  // Autenticación
  // --------------------------------------------------------------------------

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return reply.code(401).send({ error: "unauthorized", message: "Falta el access token." });
    }

    const claims = await verifyToken(signingKey, token);
    if (!claims) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "Access token inválido o vencido." });
    }

    request.claims = claims;
  });

  /**
   * Autenticación de la consola embebible.
   *
   * **El comercio sale del token y de ningún otro lado.** Los endpoints `/embed`
   * ignoran por completo cualquier `merchant` que venga en el body o la query:
   * si lo aceptaran, un comercio podría editar el request desde el navegador y
   * leer la base de clientes de otro. El token es la única fuente.
   */
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/embed/")) return;

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return reply.code(401).send({ error: "unauthorized", message: "Falta el token." });
    }

    const embed = await verifyEmbedToken(signingKey, token);
    if (!embed) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "Token de consola inválido o vencido." });
    }

    request.embed = embed;
  });

  /**
   * Autenticación del back-office de Sophos.
   *
   * Estas rutas ven **todo el ecosistema**, así que no pueden compartir
   * credencial con los productos. Antes vivían bajo `/v1/` y bastaba un token
   * de producto: eso permitía que ElMenu listara tarjetas de Noctu, consumiera
   * sus reintentos de webhook y gastara el cupo diario de notificaciones de sus
   * clientes.
   */
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/admin/") || request.url === "/admin/session") return;

    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const claims = token ? await verifyAdminToken(signingKey, token) : null;

    if (!claims) {
      return reply
        .code(401)
        .send({ error: "unauthorized", message: "Se requiere una sesión de administración." });
    }

    request.admin = claims;
  });

  /** Comercio de la sesión de consola, con sus datos de marca. */
  async function embedMerchant(request: FastifyRequest) {
    const embed = request.embed;
    if (!embed) return null;

    const found = await rows<{
      id: string;
      display_name: string;
      slug: string;
      design: CardDesign | null;
      timezone: string;
    }>(
      db.drizzle,
      sql`SELECT id, display_name, slug, design, timezone FROM merchant WHERE id = ${embed.merchantId}`,
    );

    return found[0] ?? null;
  }

  /**
   * Resuelve el comercio del request dentro del producto autenticado.
   *
   * Un comercio que no pertenece al producto que consulta devuelve 403, no 404:
   * el 404 confirmaría que existe en otro lado.
   */
  async function withMerchant(
    request: FastifyRequest,
    reply: FastifyReply,
    ref: string,
  ): Promise<ResolvedMerchant | null> {
    const claims = request.claims;
    if (!claims) {
      await reply.code(401).send({ error: "unauthorized", message: "Sin credenciales." });
      return null;
    }

    const merchant = await resolveMerchant(db, claims.productId, ref);
    if (!merchant) {
      await reply.code(403).send({
        error: "forbidden",
        message: `El comercio "${ref}" no pertenece a ${claims.productSlug}.`,
      });
      return null;
    }

    return merchant;
  }

  function badRequest(reply: FastifyReply, issues: unknown) {
    return reply.code(400).send({ error: "bad_request", issues });
  }

  // --------------------------------------------------------------------------
  // OAuth2 client_credentials
  // --------------------------------------------------------------------------

  const tokenBody = z.object({
    grant_type: z.literal("client_credentials"),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
  });

  app.post("/oauth/token", async (request, reply) => {
    const parsed = tokenBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const claims = await authenticateProduct(
      db,
      parsed.data.client_id,
      parsed.data.client_secret,
    );
    if (!claims) {
      return reply
        .code(401)
        .send({ error: "invalid_client", message: "Credenciales inválidas." });
    }

    const { accessToken, expiresIn } = await issueToken(signingKey, claims);
    return reply.send({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: `product:${claims.productSlug}`,
    });
  });

  // --------------------------------------------------------------------------
  // Comercios y programas
  // --------------------------------------------------------------------------

  const merchantBody = z.object({
    externalId: z.string().min(1),
    slug: z.string().min(1),
    legalName: z.string().min(1),
    displayName: z.string().min(1),
    timezone: z.string().optional(),
  });

  /** Alta o actualización de un comercio. Idempotente por `externalId`. */
  app.post("/v1/merchants", async (request, reply) => {
    const parsed = merchantBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const { externalId, slug, legalName, displayName, timezone } = parsed.data;
    const productId = request.claims!.productId;

    const result = await rows<{ id: string; external_id: string }>(
      db.drizzle,
      sql`INSERT INTO merchant
            (product_id, external_id, slug, legal_name, display_name, timezone)
          VALUES (${productId}, ${externalId}, ${slug}, ${legalName}, ${displayName},
                  ${timezone ?? "America/Asuncion"})
          ON CONFLICT (product_id, external_id) DO UPDATE
            SET legal_name = EXCLUDED.legal_name,
                display_name = EXCLUDED.display_name,
                timezone = EXCLUDED.timezone
          RETURNING id, external_id`,
    );

    return reply.code(200).send({ id: result[0]?.id, externalId: result[0]?.external_id });
  });

  const programBody = z.object({
    merchant: z.string().min(1),
    kind: z.enum(["points", "stamps"]),
    config: z.record(z.string(), z.unknown()),
  });

  /** Crea o reemplaza el programa activo del comercio. */
  app.put("/v1/programs", async (request, reply) => {
    const parsed = programBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const config = { ...parsed.data.config, kind: parsed.data.kind } as ProgramConfig;

    // Rechazar acá es mucho más barato que descubrir la config rota cuando el
    // comercio ya emitió mil tarjetas.
    const errors = validateConfig(config);
    if (errors.length) {
      return reply.code(400).send({ error: "invalid_config", issues: errors });
    }

    const result = await db.drizzle.transaction(async (tx) => {
      await rows(
        tx,
        sql`UPDATE program SET status = 'paused'
            WHERE merchant_id = ${merchant.id} AND status = 'active'`,
      );
      return rows<{ id: string }>(
        tx,
        sql`INSERT INTO program (merchant_id, kind, config, status)
            VALUES (${merchant.id}, ${parsed.data.kind},
                    ${JSON.stringify(config)}::jsonb, 'active')
            RETURNING id`,
      );
    });

    return reply.send({ id: result[0]?.id, merchantId: merchant.id });
  });

  const rewardBody = z.object({
    merchant: z.string().min(1),
    name: z.string().min(1),
    cost: z.number().int().positive(),
    terms: z.string().optional(),
  });

  app.post("/v1/rewards", async (request, reply) => {
    const parsed = rewardBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const program = await activeProgram(merchant.id);
    if (!program) {
      return reply
        .code(409)
        .send({ error: "no_active_program", message: "El comercio no tiene programa activo." });
    }

    const result = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO reward (program_id, merchant_id, name, cost, terms, status)
          VALUES (${program.id}, ${merchant.id}, ${parsed.data.name},
                  ${parsed.data.cost}, ${parsed.data.terms ?? null}, 'active')
          RETURNING id`,
    );

    return reply.code(201).send({ id: result[0]?.id });
  });

  // --------------------------------------------------------------------------
  // Tarjetas
  // --------------------------------------------------------------------------

  const enrollBody = z.object({
    merchant: z.string().min(1),
    phone: z.string().min(6),
    displayName: z.string().optional(),
    consentVersion: z.string().default("v1"),
    phoneVerified: z.boolean().default(false),
  });

  app.post("/v1/memberships", async (request, reply) => {
    const parsed = enrollBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    if (!normalizePhone(parsed.data.phone)) {
      return reply
        .code(400)
        .send({ error: "invalid_phone", message: "Número de celular inválido." });
    }

    const program = await activeProgram(merchant.id);
    if (!program) {
      return reply
        .code(409)
        .send({ error: "no_active_program", message: "El comercio no tiene programa activo." });
    }

    const result = await enroll(db, {
      merchantId: merchant.id,
      programId: program.id,
      phone: parsed.data.phone,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      consentVersion: parsed.data.consentVersion,
      phoneVerified: parsed.data.phoneVerified,
    });

    return reply.code(result.created ? 201 : 200).send(result);
  });

  const lookupQuery = z.object({
    merchant: z.string().min(1),
    phone: z.string().optional(),
    serial: z.string().optional(),
  });

  app.get("/v1/memberships/lookup", async (request, reply) => {
    const parsed = lookupQuery.safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);
    if (!parsed.data.phone && !parsed.data.serial) {
      return badRequest(reply, "Se requiere phone o serial.");
    }

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const membership = await lookup(db, merchant.id, {
      ...(parsed.data.phone ? { phone: parsed.data.phone } : {}),
      ...(parsed.data.serial ? { serial: parsed.data.serial } : {}),
    });

    if (!membership) {
      return reply.code(404).send({ error: "not_found", message: "Sin tarjeta en este comercio." });
    }

    return reply.send(membership);
  });

  // --------------------------------------------------------------------------
  // Eventos de negocio
  // --------------------------------------------------------------------------

  const eventBody = z.object({
    merchant: z.string().min(1),
    idempotencyKey: z.string().min(1),
    type: z.enum(EVENT_TYPES),
    occurredAt: z.string().optional(),
    amount: z.number().int().nonnegative().optional(),
    membership: z.object({
      id: z.string().optional(),
      serial: z.string().optional(),
      phone: z.string().optional(),
    }),
    payload: z.record(z.string(), z.unknown()).optional(),
  });

  app.post("/v1/events", async (request, reply) => {
    const parsed = eventBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const membershipId = await resolveMembershipId(
      merchant.id,
      parsed.data.membership,
    );
    if (!membershipId) {
      return reply
        .code(404)
        .send({ error: "membership_not_found", message: "Sin tarjeta en este comercio." });
    }

    const occurredAt = parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date();
    if (Number.isNaN(occurredAt.getTime())) {
      return badRequest(reply, "occurredAt no es una fecha válida.");
    }

    const result = await applyEvent(db, {
      productId: request.claims!.productId,
      merchantId: merchant.id,
      membershipId,
      idempotencyKey: parsed.data.idempotencyKey,
      type: parsed.data.type,
      occurredAt,
      ...(parsed.data.amount !== undefined ? { amount: parsed.data.amount } : {}),
      ...(parsed.data.payload ? { payload: parsed.data.payload } : {}),
    });

    // Solo se toca el pase si el saldo efectivamente cambió: un reintento o un
    // evento topeado no tienen nada que empujar.
    if (!result.duplicate && result.amount > 0) {
      // El pase se actualiza en silencio para que la tarjeta esté al día al
      // instante; el aviso al cliente lo decide el despachador, que es el único
      // que ve el cupo diario y puede agrupar varios consumos en uno.
      syncPassInBackground(membershipId);

      void enqueue(db, {
        membershipId,
        merchantId: merchant.id,
        kind: "balance_changed",
      }).catch((error) => {
        app.log.error({ err: error, membershipId }, "no se pudo encolar el aviso de saldo");
      });

      if (result.tier) {
        void enqueue(db, {
          membershipId,
          merchantId: merchant.id,
          kind: "tier_changed",
        }).catch(() => {});
      }

      // Un beneficio recién desbloqueado es el aviso que más visitas genera, así
      // que se dispara solo en el cruce del umbral y no en cada acumulación
      // posterior — si no, el cliente recibiría "ya podés canjear" para siempre.
      const unlocked = await rows<{ count: number }>(
        db.drizzle,
        sql`SELECT count(*)::int AS count FROM reward
            WHERE merchant_id = ${merchant.id} AND status = 'active'
              AND cost <= ${result.balance} AND cost > ${result.balance - result.amount}`,
      );
      if ((unlocked[0]?.count ?? 0) > 0) {
        void enqueue(db, {
          membershipId,
          merchantId: merchant.id,
          kind: "reward_unlocked",
        }).catch(() => {});
      }

      // Y el aviso al producto, que es el que hace que el cajero vea "este
      // cliente tiene un café gratis" cuando lo busca.
      const productId = request.claims!.productId;
      void (async () => {
        const brief = await membershipBrief(membershipId);
        if (!brief) return;

        emitWebhook(
          merchant.id,
          "membership.balance_changed",
          {
            membershipId,
            serialNumber: brief.serial_number,
            balance: result.balance,
            delta: result.amount,
            unit: result.unit,
          },
          productId,
        );

        const justUnlocked = await rewardsJustUnlocked(
          db,
          merchant.id,
          result.balance - result.amount,
          result.balance,
        );
        if (justUnlocked.length > 0) {
          emitWebhook(
            merchant.id,
            "reward.available",
            {
              membershipId,
              serialNumber: brief.serial_number,
              phone: brief.phone,
              balance: result.balance,
              rewards: justUnlocked,
            },
            productId,
          );
        }
      })().catch((error) => {
        app.log.error({ err: error, membershipId }, "falló la emisión de webhooks");
      });
    }

    // Un reintento devuelve 200 con el resultado original; el primer envío, 201.
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  // --------------------------------------------------------------------------
  // Canjes
  // --------------------------------------------------------------------------

  const redeemBody = z.object({
    merchant: z.string().min(1),
    rewardId: z.string().min(1),
    membership: z.object({
      id: z.string().optional(),
      serial: z.string().optional(),
      phone: z.string().optional(),
    }),
    redeemedBy: z.string().min(1),
  });

  app.post("/v1/redemptions", async (request, reply) => {
    const parsed = redeemBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const membershipId = await resolveMembershipId(merchant.id, parsed.data.membership);
    if (!membershipId) {
      return reply
        .code(404)
        .send({ error: "membership_not_found", message: "Sin tarjeta en este comercio." });
    }

    const result = await redeem(db, {
      merchantId: merchant.id,
      membershipId,
      rewardId: parsed.data.rewardId,
      redeemedBy: parsed.data.redeemedBy,
    });

    if (!result.ok) {
      const status = result.reason === "insufficient_balance" ? 409 : 404;
      return reply.code(status).send({ error: result.reason, ...result });
    }

    syncPassInBackground(membershipId);

    void (async () => {
      const [brief, reward] = await Promise.all([
        membershipBrief(membershipId),
        rows<{ name: string; cost: number }>(
          db.drizzle,
          sql`SELECT name, cost FROM reward WHERE id = ${parsed.data.rewardId}`,
        ),
      ]);

      emitWebhook(
        merchant.id,
        "redemption.completed",
        {
          membershipId,
          redemptionId: result.redemptionId,
          rewardId: parsed.data.rewardId,
          rewardName: reward[0]?.name ?? null,
          cost: reward[0]?.cost ?? null,
          balance: result.balance,
          redeemedBy: parsed.data.redeemedBy,
          serialNumber: brief?.serial_number ?? null,
        },
        request.claims!.productId,
      );
    })().catch(() => {});

    return reply.code(201).send(result);
  });

  // --------------------------------------------------------------------------
  // Webhooks salientes
  // --------------------------------------------------------------------------

  const webhookBody = z.object({
    url: z.string().url(),
    /**
     * Secreto con el que se firma cada entrega. Si no lo mandás, se genera uno
     * y se devuelve **una sola vez** — no se puede volver a consultar.
     */
    secret: z.string().min(16).optional(),
    /** Vacío significa todos los eventos. */
    eventTypes: z.array(z.string()).default([]),
  });

  app.post("/v1/webhook-endpoints", async (request, reply) => {
    const parsed = webhookBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    // Exigir HTTPS no es ceremonia: el cuerpo lleva teléfonos y saldos de
    // clientes, y la firma prueba el origen pero no cifra nada.
    if (!parsed.data.url.startsWith("https://") && !parsed.data.url.includes("localhost")) {
      return reply.code(400).send({
        error: "insecure_url",
        message: "La URL del webhook tiene que ser HTTPS.",
      });
    }

    const secret = parsed.data.secret ?? randomBytes(32).toString("base64url");

    // Se arma el literal de array de Postgres a mano: un array JS vacío se
    // serializa como `()`, que no es SQL válido, y el caso "sin filtro de
    // eventos" es justamente el más común.
    const eventTypes = `{${parsed.data.eventTypes.join(",")}}`;

    const created = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO webhook_endpoint (product_id, url, secret, event_types)
          VALUES (${request.claims!.productId}, ${parsed.data.url}, ${secret},
                  ${eventTypes}::text[])
          ON CONFLICT (product_id, url) DO UPDATE
            SET secret = EXCLUDED.secret, event_types = EXCLUDED.event_types, active = true
          RETURNING id`,
    );

    return reply.code(201).send({
      id: created[0]?.id,
      url: parsed.data.url,
      // Se devuelve una sola vez. Guardalo: no hay forma de recuperarlo después.
      secret,
    });
  });

  // La entrega de webhooks y el despacho de notificaciones se movieron a
  // /admin/: son operaciones de todo el ecosistema y con token de producto
  // permitían que uno consumiera los reintentos y el cupo de notificaciones del
  // otro.

  // --------------------------------------------------------------------------
  // Diseño de la tarjeta, ubicaciones y emisión del pase
  // --------------------------------------------------------------------------

  const designBody = z.object({
    merchant: z.string().min(1),
    programName: z.string().min(1),
    logoUrl: z.string().url(),
    heroImageUrl: z.string().url().optional(),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    balanceLabel: z.string().min(1),
    // Se acepta renombrarlo, no eliminarlo: en Apple es el único vehículo de
    // notificación, y agregarlo después obliga a reemitir todos los pases.
    newsLabel: z.string().min(1).default("Novedades"),
  });

  app.put("/v1/design", async (request, reply) => {
    const parsed = designBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const { merchant: _ref, ...design } = parsed.data;
    await rows(
      db.drizzle,
      sql`UPDATE merchant SET design = ${JSON.stringify(design)}::jsonb
          WHERE id = ${merchant.id}`,
    );

    return reply.send({ merchantId: merchant.id, design });
  });

  const locationBody = z.object({
    merchant: z.string().min(1),
    label: z.string().min(1),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    relevantText: z.string().optional(),
  });

  app.post("/v1/locations", async (request, reply) => {
    const parsed = locationBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    // Apple admite 10 ubicaciones por pase. Aceptar más sería aceptar en falso:
    // las que sobran no dispararían nada y nadie se enteraría.
    const existing = await rows<{ count: string }>(
      db.drizzle,
      sql`SELECT count(*)::text AS count FROM merchant_location WHERE merchant_id = ${merchant.id}`,
    );
    if (Number(existing[0]?.count ?? 0) >= 10) {
      return reply.code(409).send({
        error: "too_many_locations",
        message:
          "Máximo 10 ubicaciones por comercio: es el tope que impone Apple por pase.",
      });
    }

    const created = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO merchant_location (merchant_id, label, latitude, longitude, relevant_text)
          VALUES (${merchant.id}, ${parsed.data.label}, ${parsed.data.latitude},
                  ${parsed.data.longitude}, ${parsed.data.relevantText ?? null})
          RETURNING id`,
    );

    return reply.code(201).send({ id: created[0]?.id });
  });

  const passBody = z.object({
    merchant: z.string().min(1),
    membership: z.object({
      id: z.string().optional(),
      serial: z.string().optional(),
      phone: z.string().optional(),
    }),
    platform: z.enum(["google"]).default("google"),
  });

  /** Emite la tarjeta y devuelve el link de "Add to Google Wallet". */
  app.post("/v1/passes", async (request, reply) => {
    const parsed = passBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    if (!passes.enabled) {
      return reply.code(503).send({
        error: "wallet_not_configured",
        message:
          "Google Wallet no está configurado. Falta el Issuer ID y la service account.",
      });
    }

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const membershipId = await resolveMembershipId(merchant.id, parsed.data.membership);
    if (!membershipId) {
      return reply
        .code(404)
        .send({ error: "membership_not_found", message: "Sin tarjeta en este comercio." });
    }

    const issued = await passes.issueGooglePass(membershipId, merchant.id);
    return reply.code(201).send({ platform: "google", membershipId, ...issued });
  });

  /**
   * Pases del producto que consulta cuyo saldo quedó atrás del real.
   *
   * Filtrado por producto: antes devolvía los de todo el ecosistema, así que un
   * competidor podía estimar el volumen de tarjetas activas del otro.
   */
  app.get("/v1/passes/pending-sync", async (request, reply) => {
    return reply.send({ passes: await passes.pendingSync(100, request.claims!.productId) });
  });

  // --------------------------------------------------------------------------
  // Campañas
  // --------------------------------------------------------------------------

  /**
   * Alcance real de una campaña, antes de mandarla.
   *
   * Es el medidor en vivo que ve el comercio mientras escribe: "de tus 500
   * clientes, hoy le llega a 453". Sin esto asume alcance total y toma
   * decisiones sobre un número falso.
   */
  async function reachFor(merchantId: string) {
    const found = await rows<{ total: number; reachable: number }>(
      db.drizzle,
      sql`SELECT
            count(*) FILTER (WHERE m.status = 'active')::int AS total,
            count(*) FILTER (
              WHERE m.status = 'active'
                AND NOT ('wallet' = ANY (m.notification_optout))
                AND (SELECT count(*) FROM notification n
                     WHERE n.membership_id = m.id AND n.channel = 'wallet'
                       AND n.sent_at > now() - interval '24 hours') < ${CAMPAIGN_BUDGET}
            )::int AS reachable
          FROM membership m
          WHERE m.merchant_id = ${merchantId}`,
    );

    const total = found[0]?.total ?? 0;
    const reachable = found[0]?.reachable ?? 0;
    return { total, reachable, unreachable: total - reachable };
  }

  app.get("/v1/campaigns/reach", async (request, reply) => {
    const parsed = z
      .object({ merchant: z.string().min(1) })
      .safeParse(request.query);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    return reply.send(await reachFor(merchant.id));
  });

  const campaignBody = z.object({
    merchant: z.string().min(1),
    header: z.string().min(1).max(60),
    body: z.string().min(1).max(300),
    createdBy: z.string().min(1),
  });

  app.post("/v1/campaigns", async (request, reply) => {
    const parsed = campaignBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const created = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO campaign (merchant_id, header, body, created_by)
          VALUES (${merchant.id}, ${parsed.data.header}, ${parsed.data.body},
                  ${parsed.data.createdBy})
          RETURNING id`,
    );
    const campaignId = created[0]?.id;
    if (!campaignId) throw new Error("no se pudo crear la campaña");

    const audience = await rows<{ id: string }>(
      db.drizzle,
      sql`SELECT id FROM membership WHERE merchant_id = ${merchant.id} AND status = 'active'`,
    );

    // Se encola una por cliente y el despachador decide cuáles entran. Encolar
    // todo y reportar después es lo que permite distinguir "no le mandamos" de
    // "no le entró", que para el comercio son cosas muy distintas.
    for (const member of audience) {
      await enqueue(db, {
        membershipId: member.id,
        merchantId: merchant.id,
        kind: "campaign",
        campaignId,
        header: parsed.data.header,
        body: parsed.data.body,
        now: clock(),
      });
    }

    return reply.code(201).send({ id: campaignId, targeted: audience.length });
  });

  app.get<{ Params: { id: string } }>("/v1/campaigns/:id/report", async (request, reply) => {
    const merchantRef = (request.query as { merchant?: string }).merchant;
    if (!merchantRef) return badRequest(reply, "Falta el parámetro merchant.");

    const merchant = await withMerchant(request, reply, merchantRef);
    if (!merchant) return;

    const owned = await rows<{ id: string }>(
      db.drizzle,
      sql`SELECT id FROM campaign WHERE id = ${request.params.id} AND merchant_id = ${merchant.id}`,
    );
    if (!owned[0]) {
      return reply.code(404).send({ error: "not_found", message: "Campaña inexistente." });
    }

    return reply.send(await campaignReport(db, request.params.id));
  });

  // --------------------------------------------------------------------------
  // Back-office de Sophos
  //
  // Ve los tres niveles de la jerarquía: productos → comercios → clientes. Es
  // la única superficie que cruza productos, y por eso tiene credencial propia.
  // --------------------------------------------------------------------------

  /** Canjea la clave maestra por una sesión de back-office. */
  app.post("/admin/session", async (request, reply) => {
    const parsed = z.object({ key: z.string().min(1), operator: z.string().min(1) })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const expected = opts.adminKey ?? process.env.ADMIN_API_KEY;
    if (!expected) {
      return reply.code(503).send({
        error: "admin_disabled",
        message: "El back-office no está habilitado: falta ADMIN_API_KEY.",
      });
    }

    if (!adminKeyMatches(parsed.data.key, expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    // El operador queda en el token para poder atribuir cada acción; el
    // back-office puede suspender comercios y ver datos de todo el ecosistema.
    return reply.send(await issueAdminToken(signingKey, parsed.data.operator));
  });

  /** Panorama del ecosistema: los tres niveles de una. */
  app.get("/admin/overview", async (_request, reply) => {
    const products = await rows<{
      id: string;
      slug: string;
      name: string;
      merchants: number;
      active_programs: number;
      cards: number;
      outstanding: number;
    }>(
      db.drizzle,
      sql`SELECT p.id, p.slug, p.name,
                 count(DISTINCT m.id)::int AS merchants,
                 count(DISTINCT pr.id) FILTER (WHERE pr.status = 'active')::int AS active_programs,
                 count(DISTINCT ms.id)::int AS cards,
                 COALESCE(sum(ms.balance), 0)::int AS outstanding
          FROM product p
          LEFT JOIN merchant m ON m.product_id = p.id
          LEFT JOIN program pr ON pr.merchant_id = m.id
          LEFT JOIN membership ms ON ms.merchant_id = m.id
          GROUP BY p.id, p.slug, p.name
          ORDER BY p.slug`,
    );

    // El grafo de identidad: cuánta gente tiene tarjeta en más de un comercio.
    // Es el activo que ningún comercio puede replicar por su cuenta, y hasta
    // ahora no había forma de mirarlo.
    const graph = await rows<{ people: number; multi: number; cross_product: number }>(
      db.drizzle,
      sql`WITH por_persona AS (
            SELECT ms.person_id,
                   count(DISTINCT ms.merchant_id) AS comercios,
                   count(DISTINCT m.product_id) AS productos
            FROM membership ms
            JOIN merchant m ON m.id = ms.merchant_id
            GROUP BY ms.person_id
          )
          SELECT count(*)::int AS people,
                 count(*) FILTER (WHERE comercios > 1)::int AS multi,
                 count(*) FILTER (WHERE productos > 1)::int AS cross_product
          FROM por_persona`,
    );

    return reply.send({ products, identityGraph: graph[0] ?? null });
  });

  /** Qué está roto ahora mismo, en todo el ecosistema. */
  app.get("/admin/health", async (_request, reply) => {
    const [passes_, webhooks, notifications] = await Promise.all([
      rows<{ drifted: number; errored: number }>(
        db.drizzle,
        sql`SELECT count(*) FILTER (
                     WHERE m.balance IS DISTINCT FROM pi.last_synced_balance)::int AS drifted,
                   count(*) FILTER (WHERE pi.last_error IS NOT NULL)::int AS errored
            FROM pass_instance pi
            JOIN membership m ON m.id = pi.membership_id
            WHERE pi.state = 'active'`,
      ),
      rows<{ pending: number; exhausted: number }>(
        db.drizzle,
        sql`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                   count(*) FILTER (WHERE status = 'exhausted')::int AS exhausted
            FROM webhook_delivery`,
      ),
      rows<{ pending: number; suppressed: number }>(
        db.drizzle,
        sql`SELECT count(*) FILTER (
                     WHERE sent_at IS NULL AND suppressed_reason IS NULL)::int AS pending,
                   count(*) FILTER (WHERE suppressed_reason = 'budget_exhausted')::int AS suppressed
            FROM notification`,
      ),
    ]);

    return reply.send({
      passes: passes_[0] ?? { drifted: 0, errored: 0 },
      webhooks: webhooks[0] ?? { pending: 0, exhausted: 0 },
      notifications: notifications[0] ?? { pending: 0, suppressed: 0 },
    });
  });

  /** Comercios de todo el ecosistema, con su producto. */
  app.get("/admin/merchants", async (_request, reply) => {
    const merchants = await rows(
      db.drizzle,
      sql`SELECT m.id, m.external_id, m.slug, m.display_name, m.legal_name,
                 p.slug AS product,
                 pr.kind AS program_kind,
                 count(ms.id)::int AS cards,
                 COALESCE(sum(ms.balance), 0)::int AS outstanding,
                 max(ms.issued_at) AS last_card_at
          FROM merchant m
          JOIN product p ON p.id = m.product_id
          LEFT JOIN program pr ON pr.merchant_id = m.id AND pr.status = 'active'
          LEFT JOIN membership ms ON ms.merchant_id = m.id
          GROUP BY m.id, m.external_id, m.slug, m.display_name, m.legal_name,
                   p.slug, pr.kind
          ORDER BY p.slug, m.display_name`,
    );

    return reply.send({ merchants });
  });

  /** Alta de un producto integrador. Devuelve el secreto una sola vez. */
  app.post("/admin/products", async (request, reply) => {
    const parsed = z
      .object({ slug: z.string().min(2).max(40), name: z.string().min(2) })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const clientId = `${parsed.data.slug}-${randomBytes(6).toString("hex")}`;
    const clientSecret = randomBytes(32).toString("base64url");

    const created = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
          VALUES (${parsed.data.slug}, ${parsed.data.name}, ${clientId},
                  ${await hashSecret(clientSecret)})
          RETURNING id`,
    );

    return reply.code(201).send({
      id: created[0]?.id,
      slug: parsed.data.slug,
      clientId,
      // Una sola vez: se guarda hasheado y no hay forma de recuperarlo.
      clientSecret,
    });
  });

  /** Corre el despachador de notificaciones de todo el ecosistema. */
  app.post("/admin/notifications/dispatch", async (_request, reply) => {
    return reply.send(await dispatchDue(db, sender));
  });

  /** Corre la cola de entrega de webhooks de todo el ecosistema. */
  app.post("/admin/webhooks/deliver", async (_request, reply) => {
    return reply.send(
      await deliverDue(db, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) }),
    );
  });

  /** Pases desfasados de todo el ecosistema. */
  app.get("/admin/passes/pending-sync", async (_request, reply) => {
    return reply.send({ passes: await passes.pendingSync(200) });
  });

  // --------------------------------------------------------------------------
  // Alta pública del cliente
  //
  // A diferencia del resto, estas rutas no llevan token: la landing de alta es
  // pública por naturaleza — cualquiera con el QR de la mesa puede darse de
  // alta. La protección es el rate limit y el propio OTP, no una credencial.
  // --------------------------------------------------------------------------

  /**
   * Freno por IP, en memoria.
   *
   * El tope por número ya acota cuánto se le puede molestar a una víctima
   * puntual; esto acota que un mismo origen dispare códigos a muchos números
   * distintos, que es como se hace bombing de SMS y como se le infla la factura
   * al proveedor.
   *
   * En memoria alcanza para una sola instancia. Con varias hay que moverlo a un
   * almacén compartido, o cada réplica permitirá el tope completo por su cuenta.
   */
  const sendsByIp = new Map<string, number[]>();
  const MAX_SENDS_PER_IP_PER_HOUR = 20;

  function ipAllowed(ip: string, now = Date.now()): boolean {
    const cutoff = now - 60 * 60 * 1000;
    const recent = (sendsByIp.get(ip) ?? []).filter((t) => t > cutoff);

    if (recent.length >= MAX_SENDS_PER_IP_PER_HOUR) {
      sendsByIp.set(ip, recent);
      return false;
    }

    recent.push(now);
    sendsByIp.set(ip, recent);
    return true;
  }

  /** Resuelve un comercio por su slug público, sin exponer nada interno. */
  async function publicMerchant(slug: string) {
    const found = await rows<{
      id: string;
      display_name: string;
      design: CardDesign | null;
      program_id: string | null;
      program_kind: "points" | "stamps" | null;
    }>(
      db.drizzle,
      sql`SELECT m.id, m.display_name, m.design,
                 p.id AS program_id, p.kind AS program_kind
          FROM merchant m
          LEFT JOIN program p ON p.merchant_id = m.id AND p.status = 'active'
          WHERE m.slug = ${slug}`,
    );
    return found[0] ?? null;
  }

  /** Datos de marca para pintar la landing. */
  app.get<{ Params: { slug: string } }>("/public/merchants/:slug", async (request, reply) => {
    const merchant = await publicMerchant(request.params.slug);
    if (!merchant || !merchant.program_id) {
      return reply.code(404).send({ error: "not_found" });
    }

    return reply.send({
      slug: request.params.slug,
      displayName: merchant.display_name,
      programName: merchant.design?.programName ?? merchant.display_name,
      logoUrl: merchant.design?.logoUrl ?? null,
      backgroundColor: merchant.design?.backgroundColor ?? "#1F2937",
      unit: merchant.program_kind === "stamps" ? "stamps" : "points",
    });
  });

  const startBody = z.object({
    merchant: z.string().min(1),
    phone: z.string().min(6),
  });

  app.post("/public/enrollment/start", async (request, reply) => {
    const parsed = startBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    if (!ipAllowed(request.ip)) {
      return reply.code(429).send({
        error: "rate_limited",
        message: "Demasiados pedidos desde este origen. Probá más tarde.",
      });
    }

    const merchant = await publicMerchant(parsed.data.merchant);
    if (!merchant || !merchant.program_id) {
      return reply.code(404).send({ error: "not_found" });
    }

    const result = await startEnrollment(db, otpSender, {
      merchantId: merchant.id,
      merchantName: merchant.display_name,
      phone: parsed.data.phone,
    });

    if (result.status === "invalid_phone") {
      return reply
        .code(400)
        .send({ error: "invalid_phone", message: "Número de celular inválido." });
    }
    if (result.status === "rate_limited") {
      return reply.code(429).send({
        error: "rate_limited",
        retryAfterMinutes: result.retryAfterMinutes,
      });
    }

    return reply.send({ status: "sent", expiresAt: result.expiresAt });
  });

  const verifyBody = z.object({
    merchant: z.string().min(1),
    phone: z.string().min(6),
    code: z.string().min(4).max(8),
    displayName: z.string().min(1).max(80).optional(),
    /** Consentimiento del programa del comercio. Sin esto no hay alta. */
    acceptsProgram: z.literal(true),
    /**
     * Consentimiento separado para que Sophos conserve la identidad verificada.
     * Es opcional a propósito: son dos bases legales distintas y el cliente
     * puede aceptar una y no la otra.
     */
    acceptsSharedIdentity: z.boolean().default(false),
  });

  app.post("/public/enrollment/verify", async (request, reply) => {
    const parsed = verifyBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await publicMerchant(parsed.data.merchant);
    if (!merchant || !merchant.program_id) {
      return reply.code(404).send({ error: "not_found" });
    }

    const result = await verifyEnrollment(db, {
      merchantId: merchant.id,
      programId: merchant.program_id,
      phone: parsed.data.phone,
      code: parsed.data.code,
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      // Se registra qué consintió exactamente, no un "sí" genérico: son dos
      // bases legales distintas bajo la Ley 7593/2025.
      consentVersion: parsed.data.acceptsSharedIdentity
        ? "programa+identidad/v1"
        : "programa/v1",
    });

    if (result.status !== "verified") {
      const status = result.status === "invalid_code" ? 401 : 410;
      return reply.code(status).send({ error: result.status, ...result });
    }

    // La tarjeta ya existe; el pase es lo que falta. Si Google no está
    // configurado el alta igual valió: el cliente tiene su tarjeta web.
    let saveUrl: string | null = null;
    if (passes.enabled) {
      try {
        saveUrl = (await passes.issueGooglePass(result.membership.membershipId, merchant.id))
          .saveUrl;
      } catch (error) {
        app.log.error({ err: error }, "no se pudo emitir el pase tras el alta");
      }
    }

    return reply.code(201).send({
      status: "verified",
      membershipId: result.membership.membershipId,
      serialNumber: result.membership.serialNumber,
      balance: result.membership.balance,
      /** `true` si la persona ya existía: el alta de un toque del ecosistema. */
      personExisted: result.membership.personExisted,
      saveUrl,
    });
  });

  // --------------------------------------------------------------------------
  // Consola embebible
  // --------------------------------------------------------------------------

  const embedTokenBody = z.object({
    merchant: z.string().min(1),
    /** Quién del staff abre la consola. Queda en el token para auditar. */
    staffId: z.string().max(120).optional(),
  });

  /**
   * El producto pide un token para embeber la consola de uno de sus comercios.
   *
   * Requiere el access token del producto, así que la cadena de confianza es:
   * el producto ya autenticó a su usuario → pide este token para el comercio
   * que ese usuario administra → lo pone en el `src` del iframe.
   */
  app.post("/v1/embed-tokens", async (request, reply) => {
    const parsed = embedTokenBody.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await withMerchant(request, reply, parsed.data.merchant);
    if (!merchant) return;

    const claims = request.claims!;
    const { token, expiresIn } = await issueEmbedToken(signingKey, {
      merchantId: merchant.id,
      productId: claims.productId,
      ...(parsed.data.staffId ? { staffId: parsed.data.staffId } : {}),
    });

    return reply.send({
      token,
      expiresIn,
      merchantId: merchant.id,
      displayName: merchant.displayName,
    });
  });

  /** Números de la portada de la consola. */
  app.get("/embed/summary", async (request, reply) => {
    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const stats = await rows<{
      cards: number;
      active_cards: number;
      new_this_week: number;
      redemptions: number;
      outstanding: number;
    }>(
      db.drizzle,
      sql`SELECT
            count(*)::int AS cards,
            count(*) FILTER (WHERE status = 'active')::int AS active_cards,
            count(*) FILTER (WHERE issued_at > now() - interval '7 days')::int AS new_this_week,
            (SELECT count(*)::int FROM redemption WHERE merchant_id = ${merchant.id}) AS redemptions,
            -- Puntos en circulación: es el pasivo del comercio, lo que debe en
            -- beneficios. Es el número que más le importa y el que nadie le muestra.
            COALESCE(sum(balance), 0)::int AS outstanding
          FROM membership WHERE merchant_id = ${merchant.id}`,
    );

    return reply.send({
      merchant: { displayName: merchant.display_name, slug: merchant.slug },
      ...(stats[0] ?? {
        cards: 0,
        active_cards: 0,
        new_this_week: 0,
        redemptions: 0,
        outstanding: 0,
      }),
    });
  });

  /** Configuración del programa, para leer y para guardar. */
  app.get("/embed/program", async (request, reply) => {
    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const found = await rows<{ id: string; kind: string; config: ProgramConfig }>(
      db.drizzle,
      sql`SELECT id, kind, config FROM program
          WHERE merchant_id = ${merchant.id} AND status = 'active'`,
    );

    const program = found[0];
    if (!program) return reply.code(404).send({ error: "no_program" });

    return reply.send({ kind: program.kind, config: program.config });
  });

  const HEX = /^#[0-9a-fA-F]{6}$/;

  /**
   * Diseño de la tarjeta, con los valores por defecto ya resueltos.
   *
   * Se devuelven completos y no `null`: la pantalla necesita algo que dibujar
   * desde el primer momento, y un comercio recién dado de alta tiene que poder
   * ver su tarjeta antes de tocar nada.
   */
  app.get("/embed/design", async (request, reply) => {
    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const stored = (merchant.design ?? {}) as Partial<CardDesign>;
    const program = await activeProgram(merchant.id);
    const esSellos = program?.kind === "stamps";

    return reply.send({
      design: {
        programName: stored.programName || merchant.display_name,
        logoUrl: stored.logoUrl ?? "",
        backgroundColor: stored.backgroundColor ?? "#1F2937",
        balanceLabel: stored.balanceLabel || (esSellos ? "Sellos" : "Puntos"),
        newsLabel: stored.newsLabel || "Novedades",
        foregroundColor: stored.foregroundColor ?? "#FFFFFF",
        labelColor: stored.labelColor ?? "#FFFFFF",
        logoText: stored.logoText ?? "",
        heroImageUrl: stored.heroImageUrl ?? "",
        stripImageUrl: stored.stripImageUrl ?? "",
      },
      merchantName: merchant.display_name,
      unit: esSellos ? "stamps" : "points",
    });
  });

  app.put("/embed/design", async (request, reply) => {
    const parsed = z
      .object({
        programName: z.string().min(1).max(60),
        logoUrl: z.string().url().or(z.literal("")),
        backgroundColor: z.string().regex(HEX),
        balanceLabel: z.string().min(1).max(20),
        // Se acepta renombrarlo, nunca vaciarlo: en Apple es el único vehículo
        // de notificación y sumarlo después obliga a reemitir todos los pases.
        newsLabel: z.string().min(1).max(20),
        foregroundColor: z.string().regex(HEX),
        labelColor: z.string().regex(HEX),
        logoText: z.string().max(30).optional(),
        heroImageUrl: z.string().url().or(z.literal("")).optional(),
        stripImageUrl: z.string().url().or(z.literal("")).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    await rows(
      db.drizzle,
      sql`UPDATE merchant SET design = ${JSON.stringify(parsed.data)}::jsonb
          WHERE id = ${merchant.id}`,
    );

    return reply.send({ ok: true, design: parsed.data });
  });

  /**
   * Catálogo de beneficios, con cuántos clientes ya pueden canjear cada uno.
   *
   * Ese último dato es el que le dice al comercio si sus umbrales tienen
   * sentido. Un catálogo entero en cero significa que nadie llega nunca, y un
   * programa donde nadie canjea no retiene a nadie — pero sin el número, eso se
   * descubre recién cuando el cliente deja de volver.
   */
  app.get("/embed/rewards", async (request, reply) => {
    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const rewards = await rows<{
      id: string;
      name: string;
      cost: number;
      terms: string | null;
      status: string;
      redemptions: number;
      can_afford: number;
    }>(
      db.drizzle,
      sql`SELECT r.id, r.name, r.cost, r.terms, r.status,
                 (SELECT count(*)::int FROM redemption rd WHERE rd.reward_id = r.id) AS redemptions,
                 (SELECT count(*)::int FROM membership m
                   WHERE m.merchant_id = r.merchant_id AND m.status = 'active'
                     AND m.balance >= r.cost) AS can_afford
          FROM reward r
          WHERE r.merchant_id = ${merchant.id}
          ORDER BY r.status, r.cost`,
    );

    const totals = await rows<{ members: number }>(
      db.drizzle,
      sql`SELECT count(*)::int AS members FROM membership
          WHERE merchant_id = ${merchant.id} AND status = 'active'`,
    );

    return reply.send({ rewards, members: totals[0]?.members ?? 0 });
  });

  app.post("/embed/rewards", async (request, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(80),
        cost: z.number().int().positive(),
        terms: z.string().max(200).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const program = await activeProgram(merchant.id);
    if (!program) return reply.code(409).send({ error: "no_active_program" });

    const created = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO reward (program_id, merchant_id, name, cost, terms, status)
          VALUES (${program.id}, ${merchant.id}, ${parsed.data.name},
                  ${parsed.data.cost}, ${parsed.data.terms ?? null}, 'active')
          RETURNING id`,
    );

    return reply.code(201).send({ id: created[0]?.id });
  });

  /**
   * Archiva o reactiva un beneficio.
   *
   * No se borra nunca: puede tener canjes que lo referencian, y borrarlo
   * rompería el registro de qué recibió cada cliente. Archivado deja de
   * ofrecerse pero el historial sigue siendo legible.
   */
  app.put<{ Params: { id: string } }>("/embed/rewards/:id", async (request, reply) => {
    const parsed = z
      .object({ status: z.enum(["active", "archived"]) })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const updated = await rows<{ id: string }>(
      db.drizzle,
      sql`UPDATE reward SET status = ${parsed.data.status}
          WHERE id = ${request.params.id} AND merchant_id = ${merchant.id}
          RETURNING id`,
    );

    if (!updated[0]) return reply.code(404).send({ error: "not_found" });
    return reply.send({ ok: true });
  });

  /**
   * Avisos automáticos del comercio, con su estado.
   *
   * `campaign` no aparece: no es automático, lo escribe el comercio.
   */
  app.get("/embed/notifications", async (request, reply) => {
    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const found = await rows<{ config: ProgramConfig }>(
      db.drizzle,
      sql`SELECT config FROM program
          WHERE merchant_id = ${merchant.id} AND status = 'active'`,
    );
    const settings = found[0]?.config?.notifications ?? {};
    const disabled = new Set(settings.disabledKinds ?? []);

    return reply.send({
      kinds: AUTOMATIC_KINDS.map((k) => ({ ...k, enabled: !disabled.has(k.id) })),
      quietHours: settings.quietHours ?? null,
      // El comercio no ve "3 pushes por pase cada 24 h": ve la consecuencia.
      dailyBudget: DAILY_BUDGET,
      campaignBudget: CAMPAIGN_BUDGET,
    });
  });

  app.put("/embed/notifications", async (request, reply) => {
    const parsed = z
      .object({
        disabledKinds: z.array(z.string()).default([]),
        quietHours: z
          .object({ from: z.number().int().min(0).max(23), to: z.number().int().min(0).max(23) })
          .nullable()
          .optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const found = await rows<{ id: string; config: ProgramConfig }>(
      db.drizzle,
      sql`SELECT id, config FROM program
          WHERE merchant_id = ${merchant.id} AND status = 'active'`,
    );
    const program = found[0];
    if (!program) return reply.code(404).send({ error: "no_program" });

    const config: ProgramConfig = {
      ...program.config,
      notifications: {
        ...(program.config.notifications ?? {}),
        disabledKinds: parsed.data.disabledKinds,
        ...(parsed.data.quietHours !== undefined
          ? { quietHours: parsed.data.quietHours ?? undefined }
          : {}),
      },
    };

    await rows(
      db.drizzle,
      sql`UPDATE program SET config = ${JSON.stringify(config)}::jsonb, updated_at = now()
          WHERE id = ${program.id}`,
    );

    return reply.send({ ok: true });
  });

  /** Alcance real de la próxima campaña. */
  app.get("/embed/campaigns/reach", async (request, reply) => {
    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    return reply.send(await reachFor(merchant.id));
  });

  /** Campañas enviadas, con lo que realmente llegó. */
  app.get("/embed/campaigns", async (request, reply) => {
    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const campaigns = await rows<{
      id: string;
      header: string;
      body: string;
      created_at: string;
      targeted: number;
      delivered: number;
      pending: number;
      suppressed: number;
    }>(
      db.drizzle,
      sql`SELECT c.id, c.header, c.body, c.created_at,
                 count(n.id)::int AS targeted,
                 count(n.id) FILTER (WHERE n.sent_at IS NOT NULL)::int AS delivered,
                 count(n.id) FILTER (
                   WHERE n.sent_at IS NULL AND n.suppressed_reason IS NULL)::int AS pending,
                 count(n.id) FILTER (WHERE n.suppressed_reason IS NOT NULL)::int AS suppressed
          FROM campaign c
          LEFT JOIN notification n ON n.campaign_id = c.id
          WHERE c.merchant_id = ${merchant.id}
          GROUP BY c.id, c.header, c.body, c.created_at
          ORDER BY c.created_at DESC
          LIMIT 30`,
    );

    return reply.send({ campaigns });
  });

  app.post("/embed/campaigns", async (request, reply) => {
    const parsed = z
      .object({
        header: z.string().min(1).max(60),
        body: z.string().min(1).max(300),
      })
      .safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues);

    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const created = await rows<{ id: string }>(
      db.drizzle,
      sql`INSERT INTO campaign (merchant_id, header, body, created_by)
          VALUES (${merchant.id}, ${parsed.data.header}, ${parsed.data.body},
                  ${request.embed?.staffId ?? "consola"})
          RETURNING id`,
    );
    const campaignId = created[0]?.id;
    if (!campaignId) throw new Error("no se pudo crear la campaña");

    const audience = await rows<{ id: string }>(
      db.drizzle,
      sql`SELECT id FROM membership WHERE merchant_id = ${merchant.id} AND status = 'active'`,
    );

    // Se encola una por cliente y el despachador decide cuáles entran. Encolar
    // todo y reportar después es lo que distingue "no le mandamos" de "no le
    // entró", que para el comercio son cosas muy distintas.
    for (const member of audience) {
      await enqueue(db, {
        membershipId: member.id,
        merchantId: merchant.id,
        kind: "campaign",
        campaignId,
        header: parsed.data.header,
        body: parsed.data.body,
        now: clock(),
      });
    }

    return reply.code(201).send({ id: campaignId, targeted: audience.length });
  });

  /** Datos para imprimir el QR de alta. */
  app.get("/embed/enrollment-link", async (request, reply) => {
    const merchant = await embedMerchant(request);
    if (!merchant) return reply.code(401).send({ error: "unauthorized" });

    const base = process.env.JOIN_BASE_URL ?? "https://tarjeta.sophosgroup.com.py";
    return reply.send({
      url: `${base}/${merchant.slug}`,
      slug: merchant.slug,
      displayName: merchant.display_name,
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  // --------------------------------------------------------------------------
  // Helpers con acceso a la conexión
  // --------------------------------------------------------------------------

  async function activeProgram(
    merchantId: string,
  ): Promise<{ id: string; kind: "points" | "stamps" } | null> {
    const found = await rows<{ id: string; kind: "points" | "stamps" }>(
      db.drizzle,
      sql`SELECT id, kind FROM program WHERE merchant_id = ${merchantId} AND status = 'active'`,
    );
    return found[0] ?? null;
  }

  /** Traduce una referencia de tarjeta a su id, siempre dentro del comercio. */
  async function resolveMembershipId(
    merchantId: string,
    ref: { id?: string; serial?: string; phone?: string },
  ): Promise<string | null> {
    if (ref.id) {
      const found = await rows<{ id: string }>(
        db.drizzle,
        sql`SELECT id FROM membership WHERE id = ${ref.id} AND merchant_id = ${merchantId}`,
      );
      return found[0]?.id ?? null;
    }

    const membership = await lookup(db, merchantId, {
      ...(ref.serial ? { serial: ref.serial } : {}),
      ...(ref.phone ? { phone: ref.phone } : {}),
    });
    return membership?.id ?? null;
  }

  return app;
}
