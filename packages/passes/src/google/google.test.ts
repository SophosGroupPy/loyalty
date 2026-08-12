import { generateKeyPairSync } from "node:crypto";

import { importSPKI, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildLoyaltyClass,
  buildLoyaltyObject,
  classIdFor,
  sanitizeIdSegment,
} from "./build.js";
import { createGoogleWalletClient, GoogleWalletError } from "./client.js";
import { GOOGLE_TOKEN_URL, SAVE_LINK_BASE } from "./enums.js";
import { buildSaveLink, createTokenProvider } from "./jwt.js";
import type { CardDesign, GoogleWalletConfig, MerchantIdentity } from "./types.js";

const ISSUER_ID = "3388000000012345678";

const merchant: MerchantIdentity = {
  slug: "don-julio",
  displayName: "Don Julio",
  legalName: "Don Julio SA",
};

const design: CardDesign = {
  programName: "Puntos Don Julio",
  logoUrl: "https://cdn.sophosgroup.com.py/don-julio/logo.png",
  backgroundColor: "#DC2626",
  balanceLabel: "Puntos",
  newsLabel: "Novedades",
};

let config: GoogleWalletConfig;
let publicKeyPem: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  publicKeyPem = publicKey;
  config = {
    issuerId: ISSUER_ID,
    serviceAccountEmail: "loyalty@sophos.iam.gserviceaccount.com",
    privateKeyPem: privateKey,
    origins: ["https://tarjeta.sophosgroup.com.py"],
  };
});

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

describe("identificadores", () => {
  it("limpia acentos y caracteres que Google rechaza", () => {
    expect(sanitizeIdSegment("Bar Ñandutí")).toBe("Bar-Nanduti");
    expect(sanitizeIdSegment("café/bar #1")).toBe("cafe-bar-1");
    expect(sanitizeIdSegment("ya-valido_1.2")).toBe("ya-valido_1.2");
  });

  it("falla si no queda nada utilizable", () => {
    expect(() => sanitizeIdSegment("///")).toThrow();
  });

  it("arma el id de la clase con el issuer adelante", () => {
    expect(classIdFor(ISSUER_ID, "don-julio")).toBe(`${ISSUER_ID}.don-julio`);
  });
});

// ---------------------------------------------------------------------------
// Clase
// ---------------------------------------------------------------------------

describe("LoyaltyClass", () => {
  it("muestra al comercio como emisor, no a Sophos", () => {
    const built = buildLoyaltyClass({ issuerId: ISSUER_ID, merchant, design });

    // Lo que ve el cliente es la marca del bar. Sophos no aparece al frente.
    expect(built.issuerName).toBe("Don Julio");
    expect(built.programName).toBe("Puntos Don Julio");
    expect(JSON.stringify(built.issuerName)).not.toContain("Sophos");
  });

  it("declara en el dorso que Sophos emite por cuenta del comercio", () => {
    const built = buildLoyaltyClass({ issuerId: ISSUER_ID, merchant, design });
    const attribution = built.textModulesData?.find((m) => m.id === "emisor");

    expect(attribution?.body).toBe(
      "Emitido por Sophos Group EAS en nombre de Don Julio SA.",
    );
  });

  it("usa merchantLocations y no el campo locations deprecado", () => {
    const built = buildLoyaltyClass({
      issuerId: ISSUER_ID,
      merchant,
      design,
      locations: [{ latitude: -25.2965, longitude: -57.5759, label: "Villa Morra" }],
    });

    // `locations` quedó deprecado y Google documenta que ya no dispara
    // geo-notificaciones: mandarlo ahí sería silenciosamente inútil.
    expect(built.merchantLocations).toEqual([
      { latitude: -25.2965, longitude: -57.5759 },
    ]);
    expect(built).not.toHaveProperty("locations");
  });

  it("recorta a diez ubicaciones", () => {
    const built = buildLoyaltyClass({
      issuerId: ISSUER_ID,
      merchant,
      design,
      locations: Array.from({ length: 14 }, (_, i) => ({
        latitude: -25 - i / 100,
        longitude: -57,
      })),
    });

    expect(built.merchantLocations).toHaveLength(10);
  });

  it("solo pide notificar cuando se lo indica", () => {
    expect(
      buildLoyaltyClass({ issuerId: ISSUER_ID, merchant, design }).notifyPreference,
    ).toBeUndefined();
    expect(
      buildLoyaltyClass({ issuerId: ISSUER_ID, merchant, design, notify: true })
        .notifyPreference,
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Objeto
// ---------------------------------------------------------------------------

describe("LoyaltyObject", () => {
  const base = {
    issuerId: ISSUER_ID,
    merchantSlug: "don-julio",
    serialNumber: "7QK2M9XZ4B1T",
    balance: 340,
    balanceLabel: "Puntos",
  };

  it("pone el serial en el QR y en el accountId", () => {
    const built = buildLoyaltyObject(base);

    expect(built.barcode).toEqual({
      type: "QR_CODE",
      value: "7QK2M9XZ4B1T",
      alternateText: "7QK2M9XZ4B1T",
    });
    expect(built.accountId).toBe("7QK2M9XZ4B1T");
    expect(built.classId).toBe(`${ISSUER_ID}.don-julio`);
  });

  it("expone el saldo en la estructura que espera Google", () => {
    expect(buildLoyaltyObject(base).loyaltyPoints).toEqual({
      label: "Puntos",
      balance: { int: 340 },
    });
  });

  it("mapea mensajes de campaña a TEXT_AND_NOTIFY solo si notifican", () => {
    const built = buildLoyaltyObject({
      ...base,
      messages: [
        { id: "promo-1", header: "2x1 en tragos", body: "Hasta las 12", notify: true },
        { id: "info-1", header: "Nuevo horario", body: "Abrimos 19h", notify: false },
      ],
    });

    expect(built.messages?.[0]?.messageType).toBe("TEXT_AND_NOTIFY");
    expect(built.messages?.[1]?.messageType).toBe("TEXT");
  });

  it("marca la tarjeta como inactiva cuando corresponde", () => {
    expect(buildLoyaltyObject({ ...base, active: false }).state).toBe("INACTIVE");
    expect(buildLoyaltyObject(base).state).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// Firma
// ---------------------------------------------------------------------------

describe("link de guardado", () => {
  it("produce un JWT RS256 verificable con los claims que espera Google", async () => {
    const object = buildLoyaltyObject({
      issuerId: ISSUER_ID,
      merchantSlug: "don-julio",
      serialNumber: "7QK2M9XZ4B1T",
      balance: 10,
      balanceLabel: "Puntos",
    });

    const link = await buildSaveLink(config, { object });
    expect(link.startsWith(SAVE_LINK_BASE)).toBe(true);

    const token = link.slice(SAVE_LINK_BASE.length);
    const { payload, protectedHeader } = await jwtVerify(
      token,
      await importSPKI(publicKeyPem, "RS256"),
      { audience: "google" },
    );

    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe(config.serviceAccountEmail);
    expect(payload.typ).toBe("savetowallet");
    expect(payload.origins).toEqual(["https://tarjeta.sophosgroup.com.py"]);
    expect(payload.iat).toBeTypeOf("number");

    const inner = payload.payload as { loyaltyObjects: { id: string }[] };
    expect(inner.loyaltyObjects[0]?.id).toBe(`${ISSUER_ID}.7QK2M9XZ4B1T`);
  });

  it("puede incluir la clase para que el primer guardado no dependa de la API", async () => {
    const link = await buildSaveLink(config, {
      object: buildLoyaltyObject({
        issuerId: ISSUER_ID,
        merchantSlug: "don-julio",
        serialNumber: "AAA",
        balance: 0,
        balanceLabel: "Puntos",
      }),
      loyaltyClass: buildLoyaltyClass({ issuerId: ISSUER_ID, merchant, design }),
    });

    const { payload } = await jwtVerify(
      link.slice(SAVE_LINK_BASE.length),
      await importSPKI(publicKeyPem, "RS256"),
      { audience: "google" },
    );

    const inner = payload.payload as { loyaltyClasses?: unknown[] };
    expect(inner.loyaltyClasses).toHaveLength(1);
  });

  it("acepta una clave privada con los saltos de línea escapados", async () => {
    // Es el error más común al pasar la clave por variable de entorno: el JSON
    // de GCP trae `\n` literales y falla con un "PEM inválido" que no orienta.
    const escaped: GoogleWalletConfig = {
      ...config,
      privateKeyPem: config.privateKeyPem.replace(/\n/g, "\\n"),
    };

    await expect(
      buildSaveLink(escaped, {
        object: buildLoyaltyObject({
          issuerId: ISSUER_ID,
          merchantSlug: "don-julio",
          serialNumber: "AAA",
          balance: 0,
          balanceLabel: "Puntos",
        }),
      }),
    ).resolves.toContain(SAVE_LINK_BASE);
  });
});

// ---------------------------------------------------------------------------
// Cliente REST
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** Doble de `fetch` que responde el token y encola respuestas para la API. */
function fakeFetch(apiResponses: { status: number; body?: unknown }[]) {
  const calls: RecordedCall[] = [];
  let tokenRequests = 0;
  let next = 0;

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);

    if (href === GOOGLE_TOKEN_URL) {
      tokenRequests += 1;
      return new Response(
        JSON.stringify({ access_token: `token-${tokenRequests}`, expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    calls.push({
      url: href,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const response = apiResponses[next++] ?? { status: 200 };
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { impl, calls, tokenRequests: () => tokenRequests };
}

describe("cliente REST", () => {
  it("crea la clase y, si ya existe, la actualiza", async () => {
    const fake = fakeFetch([{ status: 409 }, { status: 200 }]);
    const client = createGoogleWalletClient(config, fake.impl);

    await client.upsertClass(buildLoyaltyClass({ issuerId: ISSUER_ID, merchant, design }));

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.method).toBe("POST");
    expect(fake.calls[0]?.url).toContain("/loyaltyClass");
    expect(fake.calls[1]?.method).toBe("PATCH");
    expect(fake.calls[1]?.url).toContain(encodeURIComponent(`${ISSUER_ID}.don-julio`));
  });

  it("no vuelve a actualizar si la creación salió bien", async () => {
    const fake = fakeFetch([{ status: 200 }]);
    const client = createGoogleWalletClient(config, fake.impl);

    await client.upsertClass(buildLoyaltyClass({ issuerId: ISSUER_ID, merchant, design }));
    expect(fake.calls).toHaveLength(1);
  });

  it("manda notifyPreference solo cuando el saldo debe notificar", async () => {
    const fake = fakeFetch([{ status: 200 }, { status: 200 }]);
    const client = createGoogleWalletClient(config, fake.impl);

    await client.syncBalance({
      objectId: `${ISSUER_ID}.AAA`,
      balance: 12,
      balanceLabel: "Puntos",
      notify: true,
    });
    await client.syncBalance({
      objectId: `${ISSUER_ID}.AAA`,
      balance: 13,
      balanceLabel: "Puntos",
      notify: false,
    });

    expect(fake.calls[0]?.body).toMatchObject({
      loyaltyPoints: { balance: { int: 12 } },
      notifyPreference: expect.any(String),
    });
    expect(fake.calls[1]?.body).not.toHaveProperty("notifyPreference");
  });

  it("reutiliza el access token entre llamadas", async () => {
    const fake = fakeFetch([{ status: 200 }, { status: 200 }, { status: 200 }]);
    const client = createGoogleWalletClient(config, fake.impl);

    await client.syncBalance({ objectId: "a", balance: 1, balanceLabel: "P", notify: false });
    await client.syncBalance({ objectId: "a", balance: 2, balanceLabel: "P", notify: false });
    await client.syncBalance({ objectId: "a", balance: 3, balanceLabel: "P", notify: false });

    // Un solo intercambio de credenciales para las tres llamadas.
    expect(fake.tokenRequests()).toBe(1);
  });

  it("envía los mensajes de campaña por addMessage", async () => {
    const fake = fakeFetch([{ status: 200 }]);
    const client = createGoogleWalletClient(config, fake.impl);

    await client.addMessage(`${ISSUER_ID}.AAA`, {
      id: "promo-1",
      header: "2x1 en tragos",
      body: "Hasta las 12",
      notify: true,
    });

    expect(fake.calls[0]?.url).toContain("/addMessage");
    expect(fake.calls[0]?.body).toEqual({
      message: {
        id: "promo-1",
        header: "2x1 en tragos",
        body: "Hasta las 12",
        messageType: "TEXT_AND_NOTIFY",
      },
    });
  });

  it("propaga los errores de Google con el cuerpo de la respuesta", async () => {
    const fake = fakeFetch([{ status: 403, body: { error: "sin permisos" } }]);
    const client = createGoogleWalletClient(config, fake.impl);

    await expect(
      client.syncBalance({ objectId: "a", balance: 1, balanceLabel: "P", notify: false }),
    ).rejects.toThrow(GoogleWalletError);
  });
});
