/**
 * Verificación del alta con OTP.
 *
 * Es la superficie más sensible del sistema: verificar un celular ajeno no es
 * suplantar a alguien en un comercio, es apropiarse de su identidad en todo el
 * ecosistema. Estos tests cubren las defensas, no solo el camino feliz.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, rows, type Db } from "@sophos/db";

import { hashSecret } from "./auth.js";
import { OTP_LIMITS, type OtpMessage, type OtpSender } from "./enrollment.js";
import { normalizePhone } from "./memberships.js";
import { createServer } from "./server.js";

const SIGNING_KEY = new TextEncoder().encode("test-signing-key");

let db: Db;
let app: FastifyInstance;
let token: string;
let codes: OtpMessage[];

/** Sender que captura los códigos en vez de mandarlos. */
function capturingSender(): OtpSender {
  return {
    async send(message) {
      codes.push(message);
    },
  };
}

/** Último código emitido para un número. */
function lastCode(phone = "+595993427654"): string {
  const found = [...codes].reverse().find((c) => c.phone === phone);
  if (!found) throw new Error(`no se emitió código para ${phone}`);
  return found.code;
}

beforeEach(async () => {
  db = await createTestDb();
  codes = [];

  await rows(
    db.drizzle,
    sql`INSERT INTO product (slug, name, client_id, client_secret_hash)
        VALUES ('elmenu', 'ElMenu', 'cid', ${await hashSecret("sec")})`,
  );

  app = createServer({ db, signingKey: SIGNING_KEY, otpSender: capturingSender() });
  await app.ready();

  const auth = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: { grant_type: "client_credentials", client_id: "cid", client_secret: "sec" },
  });
  token = auth.json().access_token;

  await seedMerchant("r-1", "don-julio", "Don Julio");
});

afterEach(async () => {
  await app.close();
  await db.close();
});

async function seedMerchant(externalId: string, slug: string, name: string) {
  const call = (method: "POST" | "PUT", url: string, payload: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as object,
    });

  await call("POST", "/v1/merchants", {
    externalId,
    slug,
    legalName: `${name} SA`,
    displayName: name,
  });
  await call("PUT", "/v1/programs", {
    merchant: externalId,
    kind: "points",
    config: { earn: [{ on: "order.paid", rate: { per: 10_000, points: 1 } }] },
  });
}

function start(merchant = "don-julio", phone = "0993427654") {
  return app.inject({
    method: "POST",
    url: "/public/enrollment/start",
    payload: { merchant, phone },
  });
}

function verify(overrides: Record<string, unknown> = {}) {
  const phone = (overrides.phone as string) ?? "0993427654";
  // El código se resuelve a partir del teléfono final, no del de por defecto:
  // calcularlo antes de aplicar los overrides buscaba el número equivocado.
  const code = overrides.code ?? lastCode(normalizePhone(phone)!);

  return app.inject({
    method: "POST",
    url: "/public/enrollment/verify",
    payload: {
      merchant: "don-julio",
      displayName: "Ana",
      acceptsProgram: true,
      acceptsSharedIdentity: true,
      ...overrides,
      phone,
      code,
    },
  });
}

// ---------------------------------------------------------------------------

describe("landing pública", () => {
  it("expone la marca del comercio sin exigir token", async () => {
    await app.inject({
      method: "PUT",
      url: "/v1/design",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        merchant: "r-1",
        programName: "Puntos Don Julio",
        logoUrl: "https://cdn.example.com/logo.png",
        backgroundColor: "#DC2626",
        balanceLabel: "Puntos",
        newsLabel: "Novedades",
      },
    });

    const res = await app.inject({ method: "GET", url: "/public/merchants/don-julio" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      displayName: "Don Julio",
      programName: "Puntos Don Julio",
      backgroundColor: "#DC2626",
      unit: "points",
    });
  });

  it("404 para un comercio inexistente", async () => {
    const res = await app.inject({ method: "GET", url: "/public/merchants/no-existe" });
    expect(res.statusCode).toBe(404);
  });
});

describe("camino feliz", () => {
  it("manda un código y da de alta la tarjeta al verificarlo", async () => {
    const sent = await start();
    expect(sent.statusCode).toBe(200);
    expect(codes).toHaveLength(1);
    expect(codes[0]?.code).toMatch(/^\d{6}$/);
    expect(codes[0]?.merchantName).toBe("Don Julio");

    const verified = await verify();
    expect(verified.statusCode, verified.body).toBe(201);
    expect(verified.json()).toMatchObject({
      status: "verified",
      balance: 0,
      personExisted: false,
    });
    expect(verified.json().serialNumber).toMatch(/^[0-9A-Z]{12}$/);
  });

  it("deja el celular marcado como verificado", async () => {
    await start();
    await verify();

    const person = await rows<{ phone_verified_at: string | null }>(
      db.drizzle,
      sql`SELECT phone_verified_at FROM person WHERE phone_e164 = '+595993427654'`,
    );
    expect(person[0]?.phone_verified_at).not.toBeNull();
  });

  it("registra qué consintió exactamente, no un sí genérico", async () => {
    await start();
    await verify({ acceptsSharedIdentity: false });

    const person = await rows<{ consent_version: string }>(
      db.drizzle,
      sql`SELECT consent_version FROM person WHERE phone_e164 = '+595993427654'`,
    );
    // Son dos bases legales distintas bajo la Ley 7593/2025: hay que poder
    // demostrar cuál de las dos aceptó cada persona.
    expect(person[0]?.consent_version).toBe("programa/v1");
  });
});

describe("defensas del código", () => {
  it("rechaza un código incorrecto y descuenta intentos", async () => {
    await start();

    const res = await verify({ code: "000000" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_code");
    expect(res.json().attemptsLeft).toBe(OTP_LIMITS.maxAttempts - 1);
  });

  it("quema el desafío tras agotar los intentos", async () => {
    await start();
    const real = lastCode();

    for (let i = 0; i < OTP_LIMITS.maxAttempts; i++) {
      await verify({ code: "000000" });
    }

    // Ni siquiera el código correcto sirve ya: el desafío está consumido.
    const res = await verify({ code: real });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("no_challenge");
  });

  it("rechaza un código vencido", async () => {
    await start();

    await rows(
      db.drizzle,
      sql`UPDATE otp_challenge SET expires_at = now() - interval '1 minute'`,
    );

    const res = await verify();
    expect(res.json().error).toBe("expired");
  });

  it("pedir un código nuevo invalida el anterior", async () => {
    await start();
    const primero = lastCode();
    await start();

    // Dos códigos válidos a la vez duplicarían la superficie de adivinación.
    const res = await verify({ code: primero });
    expect(res.statusCode).toBe(401);

    expect((await verify({ code: lastCode() })).statusCode).toBe(201);
  });

  it("un código de un comercio no sirve en otro", async () => {
    await seedMerchant("r-2", "la-cabrera", "La Cabrera");
    await start("don-julio");

    const res = await app.inject({
      method: "POST",
      url: "/public/enrollment/verify",
      payload: {
        merchant: "la-cabrera",
        phone: "0993427654",
        code: lastCode(),
        acceptsProgram: true,
      },
    });

    expect(res.json().error).toBe("no_challenge");
  });

  it("no guarda el código en claro", async () => {
    await start();

    const stored = await rows<{ code_hash: string }>(
      db.drizzle,
      sql`SELECT code_hash FROM otp_challenge`,
    );
    expect(stored[0]?.code_hash).not.toContain(lastCode());
    expect(stored[0]?.code_hash.startsWith("scrypt$")).toBe(true);
  });
});

describe("límites de envío", () => {
  it("corta tras varios pedidos para el mismo número", async () => {
    for (let i = 0; i < OTP_LIMITS.maxSendsPerHour; i++) {
      expect((await start()).statusCode).toBe(200);
    }

    const res = await start();
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("rate_limited");
    expect(codes).toHaveLength(OTP_LIMITS.maxSendsPerHour);
  });

  it("el tope es por número, no global", async () => {
    for (let i = 0; i < OTP_LIMITS.maxSendsPerHour; i++) {
      await start("don-julio", "0993427654");
    }

    // Otro cliente del mismo comercio no queda bloqueado por el abuso ajeno.
    expect((await start("don-julio", "0981111111")).statusCode).toBe(200);
  });
});

describe("registro de la redacción consentida", () => {
  it("guarda los ids que la landing dice haber mostrado", async () => {
    await start();
    await verify({ consentIds: ["programa/v1", "identidad/v2"] });

    const person = await rows<{ consent_version: string }>(
      db.drizzle,
      sql`SELECT consent_version FROM person WHERE phone_e164 = '+595993427654'`,
    );
    expect(person[0]?.consent_version).toBe("programa/v1+identidad/v2");
  });

  it("rechaza una redacción que este servidor no conoce", async () => {
    // El caso que importa: alguien edita el texto de la casilla y sube la
    // versión sin avisar acá. Tiene que fallar de entrada — un alta guardada
    // bajo una etiqueta cuyo texto nadie puede reconstruir no sirve como prueba
    // de consentimiento, y el problema recién se vería en un reclamo.
    await start();
    const res = await verify({ consentIds: ["programa/v1", "identidad/v9"] });
    expect(res.statusCode).toBe(400);

    const people = await rows<{ count: string }>(
      db.drizzle,
      sql`SELECT count(*)::text AS count FROM person`,
    );
    expect(people[0]?.count).toBe("0");
  });

  it("sigue aceptando un cliente que todavía no manda los ids", async () => {
    await start();
    const res = await verify({ acceptsSharedIdentity: false });
    expect(res.statusCode).toBe(201);

    const person = await rows<{ consent_version: string }>(
      db.drizzle,
      sql`SELECT consent_version FROM person WHERE phone_e164 = '+595993427654'`,
    );
    expect(person[0]?.consent_version).toBe("programa/v1");
  });
});

describe("consentimiento e identidad compartida", () => {
  it("no deja darse de alta sin aceptar el programa", async () => {
    await start();

    const res = await verify({ acceptsProgram: false });
    expect(res.statusCode).toBe(400);

    const memberships = await rows<{ count: string }>(
      db.drizzle,
      sql`SELECT count(*)::text AS count FROM membership`,
    );
    expect(memberships[0]?.count).toBe("0");
  });

  it("el segundo comercio reconoce a la persona: el alta de un toque", async () => {
    await start();
    await verify();

    await seedMerchant("r-2", "la-cabrera", "La Cabrera");
    await start("la-cabrera");

    const res = await app.inject({
      method: "POST",
      url: "/public/enrollment/verify",
      payload: {
        merchant: "la-cabrera",
        phone: "+595 993 427654",
        code: lastCode(),
        acceptsProgram: true,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().personExisted).toBe(true);

    // Una sola persona, dos tarjetas independientes.
    const people = await rows<{ count: string }>(
      db.drizzle,
      sql`SELECT count(*)::text AS count FROM person`,
    );
    expect(people[0]?.count).toBe("1");

    const cards = await rows<{ count: string }>(
      db.drizzle,
      sql`SELECT count(*)::text AS count FROM membership`,
    );
    expect(cards[0]?.count).toBe("2");
  });

  it("responde igual exista o no la persona", async () => {
    // Si la respuesta cambiara, la pantalla de alta sería un oráculo para
    // averiguar si un número es cliente de un comercio.
    const nueva = await start("don-julio", "0981111111");
    await verify({ phone: "0981111111", code: lastCode("+595981111111") });

    const existente = await start("don-julio", "0981111111");

    expect(existente.statusCode).toBe(nueva.statusCode);
    expect(Object.keys(existente.json())).toEqual(Object.keys(nueva.json()));
  });
});
