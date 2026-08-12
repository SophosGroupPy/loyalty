/**
 * Integración de la capa de wallet con el ledger.
 *
 * El caso que más importa acá es el de la caída: **una falla de Google no puede
 * convertir una acumulación exitosa en un error.** El cliente ya consumió y sus
 * puntos le corresponden; el pase es una vista que se pone al día después.
 */

import { generateKeyPairSync } from "node:crypto";

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { importSPKI, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";
import { SAVE_LINK_BASE, type GoogleWalletConfig } from "@sophos/passes";

import { hashSecret } from "./auth.js";
import { createPassService } from "./passes.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("test-signing-key-que-no-va-a-produccion");
const ISSUER_ID = "3388000000012345678";

let walletConfig: GoogleWalletConfig;
let publicKeyPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  publicKeyPem = publicKey;
  walletConfig = {
    issuerId: ISSUER_ID,
    serviceAccountEmail: "loyalty@sophos.iam.gserviceaccount.com",
    privateKeyPem: privateKey,
    origins: ["https://tarjeta.sophosgroup.com.py"],
  };
});

/** `fetch` falso: responde el token siempre y la API según lo que se le indique. */
function walletFetch(options: { fail?: boolean } = {}) {
  const calls: { url: string; method: string; body: Record<string, unknown> | undefined }[] = [];

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);

    if (href.includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), {
        status: 200,
      });
    }

    calls.push({
      url: href,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    return options.fail
      ? new Response(JSON.stringify({ error: "Google caído" }), { status: 503 })
      : new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  return { impl, calls };
}

let db: Db;
let app: FastifyInstance;
let token: string;

async function boot(overrides: Parameters<typeof createServer>[0] extends infer T ? Partial<T> : never = {}) {
  db = await createTestDb();
  await rows(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid', ${await hashSecret("sec")})`,
  );

  app = createServer({ db, signingKey: SIGNING_KEY, ...overrides });
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "client_credentials", client_id: "cid", client_secret: "sec" },
  });
  token = res.json().access_token;
}

function call(method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload: payload as object } : {}),
  });
}

/** Comercio con programa y una tarjeta emitida. Devuelve el id de la membresía. */
async function seedCard(): Promise<string> {
  await call("POST", "/v1/merchants", {
    externalId: "r-1",
    slug: "don-julio",
    legalName: "Don Julio SA",
    displayName: "Don Julio",
  });
  await call("PUT", "/v1/programs", {
    merchant: "r-1",
    kind: "points",
    config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
  });

  const card = await call("POST", "/v1/memberships", {
    merchant: "r-1",
    phone: "0993427654",
    displayName: "Ana",
    phoneVerified: true,
  });
  return card.json().membershipId;
}

afterEach(async () => {
  await app.close();
  await db.close();
});

// ---------------------------------------------------------------------------

describe("degradación sin credenciales", () => {
  beforeEach(async () => {
    await boot();
  });

  it("responde 503 en /v1/passes sin romper el resto del sistema", async () => {
    const membershipId = await seedCard();

    const pass = await call("POST", "/v1/passes", {
      merchant: "r-1",
      membership: { id: membershipId },
    });
    expect(pass.statusCode).toBe(503);
    expect(pass.json().error).toBe("wallet_not_configured");

    // Y la acumulación sigue funcionando igual: la fase 1 no depende de wallets.
    const event = await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 50_000,
      membership: { id: membershipId },
    });
    expect(event.statusCode).toBe(201);
    expect(event.json().balance).toBe(5);
  });
});

describe("emisión con Google configurado", () => {
  let fake: ReturnType<typeof walletFetch>;

  beforeEach(async () => {
    fake = walletFetch();
    await boot({ googleWallet: walletConfig, fetchImpl: fake.impl });
  });

  it("devuelve un save link firmado con la marca del comercio", async () => {
    const membershipId = await seedCard();

    const res = await call("POST", "/v1/passes", {
      merchant: "r-1",
      membership: { id: membershipId },
    });
    expect(res.statusCode, res.body).toBe(201);

    const { saveUrl } = res.json();
    expect(saveUrl.startsWith(SAVE_LINK_BASE)).toBe(true);

    const { payload } = await jwtVerify(
      saveUrl.slice(SAVE_LINK_BASE.length),
      await importSPKI(publicKeyPem, "RS256"),
      { audience: "google" },
    );

    const inner = payload.payload as {
      loyaltyObjects: { accountName?: string; loyaltyPoints?: { balance: { int: number } } }[];
      loyaltyClasses: { issuerName: string }[];
    };

    // Lo que ve el cliente es Don Julio, no Sophos.
    expect(inner.loyaltyClasses[0]?.issuerName).toBe("Don Julio");
    expect(inner.loyaltyObjects[0]?.accountName).toBe("Ana");
    expect(inner.loyaltyObjects[0]?.loyaltyPoints?.balance.int).toBe(0);
  });

  it("registra el pase para poder sincronizarlo después", async () => {
    const membershipId = await seedCard();
    await call("POST", "/v1/passes", { merchant: "r-1", membership: { id: membershipId } });

    const stored = await rows<{ platform: string; external_id: string; last_synced_balance: number }>(
      db.drizzle,
      sql`SELECT platform, external_id, last_synced_balance FROM pass_instance
          WHERE membership_id = ${membershipId}`,
    );

    expect(stored[0]?.platform).toBe("google");
    expect(stored[0]?.external_id).toContain(ISSUER_ID);
    expect(stored[0]?.last_synced_balance).toBe(0);
  });

  it("empuja el saldo nuevo al pase en silencio, sin gastar cupo de avisos", async () => {
    const membershipId = await seedCard();
    await call("POST", "/v1/passes", { merchant: "r-1", membership: { id: membershipId } });

    await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 120_000,
      membership: { id: membershipId },
    });

    // La sincronización sale disparada por la propia acumulación, fuera de la
    // respuesta. Se espera a que aterrice en vez de forzarla a mano: es el
    // camino real que va a correr en producción.
    await vi.waitFor(async () => {
      const stored = await rows<{ last_synced_balance: number | null }>(
        db.drizzle,
        sql`SELECT last_synced_balance FROM pass_instance WHERE membership_id = ${membershipId}`,
      );
      expect(stored[0]?.last_synced_balance).toBe(12);
    });

    const patch = fake.calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toMatchObject({ loyaltyPoints: { balance: { int: 12 } } });

    // Sin `notifyPreference`: mantener la tarjeta al día es silencioso. Si esto
    // notificara, seis consumos en una noche gastarían el cupo del día entero
    // sin que el despachador —el único que ve el cupo— lo hubiera decidido.
    expect(patch?.body).not.toHaveProperty("notifyPreference");
  });

  it("no vuelve a sincronizar si el pase ya está al día", async () => {
    const membershipId = await seedCard();
    await call("POST", "/v1/passes", { merchant: "r-1", membership: { id: membershipId } });

    const service = createPassService(db, walletConfig, fake.impl);
    // Cada PATCH de más gasta cupo de notificaciones del cliente sin motivo.
    expect(await service.syncGooglePass(membershipId)).toEqual({
      status: "skipped",
      reason: "already_current",
    });
  });

  it("lleva el diseño y las geocercas configuradas a la tarjeta", async () => {
    const membershipId = await seedCard();

    await call("PUT", "/v1/design", {
      merchant: "r-1",
      programName: "Puntos Don Julio",
      logoUrl: "https://cdn.sophosgroup.com.py/don-julio.png",
      backgroundColor: "#DC2626",
      balanceLabel: "Puntos",
      newsLabel: "Novedades",
    });
    await call("POST", "/v1/locations", {
      merchant: "r-1",
      label: "Villa Morra",
      latitude: -25.2965,
      longitude: -57.5759,
    });

    const res = await call("POST", "/v1/passes", {
      merchant: "r-1",
      membership: { id: membershipId },
    });

    const { payload } = await jwtVerify(
      res.json().saveUrl.slice(SAVE_LINK_BASE.length),
      await importSPKI(publicKeyPem, "RS256"),
      { audience: "google" },
    );
    const built = (payload.payload as { loyaltyClasses: Record<string, unknown>[] })
      .loyaltyClasses[0]!;

    expect(built.programName).toBe("Puntos Don Julio");
    expect(built.hexBackgroundColor).toBe("#DC2626");
    expect(built.merchantLocations).toEqual([
      { latitude: -25.2965, longitude: -57.5759 },
    ]);
  });

  it("rechaza la ubicación número once", async () => {
    await seedCard();

    for (let i = 0; i < 10; i++) {
      const res = await call("POST", "/v1/locations", {
        merchant: "r-1",
        label: `Sucursal ${i}`,
        latitude: -25 - i / 100,
        longitude: -57,
      });
      expect(res.statusCode).toBe(201);
    }

    // Apple admite 10 por pase: aceptar la 11 sería aceptar en falso.
    const extra = await call("POST", "/v1/locations", {
      merchant: "r-1",
      label: "Sucursal 11",
      latitude: -25.5,
      longitude: -57,
    });
    expect(extra.statusCode).toBe(409);
    expect(extra.json().error).toBe("too_many_locations");
  });
});

describe("resiliencia ante una caída de Google", () => {
  it("la acumulación sigue siendo exitosa aunque el pase no se pueda actualizar", async () => {
    const caido = walletFetch({ fail: true });
    await boot({ googleWallet: walletConfig, fetchImpl: caido.impl });

    const membershipId = await seedCard();
    await call("POST", "/v1/passes", { merchant: "r-1", membership: { id: membershipId } });

    const event = await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 300_000,
      membership: { id: membershipId },
    });

    // Lo esencial: el cliente consumió y sus 30 puntos están registrados,
    // aunque Google no haya podido enterarse.
    expect(event.statusCode).toBe(201);
    expect(event.json().balance).toBe(30);

    const service = createPassService(db, walletConfig, caido.impl);
    const outcome = await service.syncGooglePass(membershipId);
    expect(outcome.status).toBe("failed");

    const stored = await rows<{ last_error: string | null }>(
      db.drizzle,
      sql`SELECT last_error FROM pass_instance WHERE membership_id = ${membershipId}`,
    );
    expect(stored[0]?.last_error).toContain("503");
  });

  it("deja el pase en la cola de reconciliación con el desfasaje", async () => {
    const caido = walletFetch({ fail: true });
    await boot({ googleWallet: walletConfig, fetchImpl: caido.impl });

    const membershipId = await seedCard();
    await call("POST", "/v1/passes", { merchant: "r-1", membership: { id: membershipId } });
    await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 300_000,
      membership: { id: membershipId },
    });

    const pending = await call("GET", "/v1/passes/pending-sync");
    expect(pending.json().passes).toEqual([{ membershipId, drift: 30 }]);
  });

  it("una vez que Google vuelve, la reconciliación pone el pase al día", async () => {
    const caido = walletFetch({ fail: true });
    await boot({ googleWallet: walletConfig, fetchImpl: caido.impl });

    const membershipId = await seedCard();
    await call("POST", "/v1/passes", { merchant: "r-1", membership: { id: membershipId } });
    await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 300_000,
      membership: { id: membershipId },
    });

    const sano = walletFetch();
    const service = createPassService(db, walletConfig, sano.impl);

    for (const { membershipId: id } of await service.pendingSync()) {
      expect(await service.syncGooglePass(id)).toEqual({ status: "synced", balance: 30 });
    }

    expect(await service.pendingSync()).toEqual([]);
  });

  it("responde igual aunque el servicio de pases lance una excepción", async () => {
    const explota = {
      enabled: true,
      issueGooglePass: vi.fn(),
      syncGooglePass: vi.fn().mockRejectedValue(new Error("boom")),
      sendMessage: vi.fn().mockRejectedValue(new Error("boom")),
      pendingSync: vi.fn().mockResolvedValue([]),
    };
    await boot({ passService: explota });

    const membershipId = await seedCard();
    const event = await call("POST", "/v1/events", {
      merchant: "r-1",
      idempotencyKey: "order-1",
      type: "order.paid",
      amount: 50_000,
      membership: { id: membershipId },
    });

    expect(event.statusCode).toBe(201);
    expect(event.json().balance).toBe(5);
  });
});
