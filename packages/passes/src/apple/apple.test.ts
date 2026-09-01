/**
 * El `.pkpass` se verifica con herramientas ajenas a este código.
 *
 * Un zip que solo abre el módulo que lo escribió, y una firma que solo valida
 * quien la produjo, no prueban nada: reproducen el mismo error de los dos lados.
 * Por eso los tests descomprimen con el `unzip` del sistema y verifican la firma
 * con `openssl`. Si el formato está mal, falla acá y no en un iPhone.
 */

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import forge from "node-forge";
import { beforeAll, describe, expect, it } from "vitest";

import type { CardDesign, MerchantIdentity } from "../google/types.js";
import { buildStoreCard, hexToRgb, MAX_LOCATIONS, NEWS_FIELD_KEY } from "./build.js";
import { buildPkpass, PassBuildError } from "./pkpass.js";
import { buildManifest, signManifest } from "./sign.js";
import { createZip } from "./zip.js";
import type { AppleWalletConfig, PassSigningMaterial } from "./types.js";

// ---------------------------------------------------------------------------

const design: CardDesign = {
  programName: "Puntos Don Julio",
  logoUrl: "https://ejemplo.com/logo.png",
  backgroundColor: "#DC2626",
  balanceLabel: "Puntos",
  newsLabel: "Novedades",
  foregroundColor: "#FFFFFF",
  labelColor: "#FCA5A5",
  logoText: "Don Julio",
};

const merchant: MerchantIdentity = {
  slug: "don-julio",
  displayName: "Don Julio",
  legalName: "Don Julio SA",
};

const config: AppleWalletConfig = {
  teamIdentifier: "ABCDE12345",
  webServiceURL: "https://tarjeta.sophosgroup.com.py",
};

const TOKEN = "token-de-pase-de-32-caracteres-ok";

function pass(overrides: Partial<Parameters<typeof buildStoreCard>[0]> = {}) {
  return buildStoreCard({
    design,
    merchant,
    config,
    serialNumber: "SN-0001",
    authenticationToken: TOKEN,
    balance: 340,
    ...overrides,
  });
}

/** Certificado autofirmado, para no depender de material real de Apple. */
function makeCert(commonName: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(2020, 0, 1);
  cert.validity.notAfter = new Date(2030, 0, 1);
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

  return { certificatePem: forge.pki.certificateToPem(cert), privateKeyPem: privateKey };
}

let material: PassSigningMaterial;

beforeAll(() => {
  const signer = makeCert("Pass Type ID: pass.com.sophosgroup.l.don-julio");
  const wwdr = makeCert("Apple Worldwide Developer Relations CA");
  material = {
    passTypeIdentifier: "pass.com.sophosgroup.l.don-julio",
    certificatePem: signer.certificatePem,
    privateKeyPem: signer.privateKeyPem,
    wwdrCertificatePem: wwdr.certificatePem,
  };
});

const images = { "icon.png": Buffer.from("PNG-falso-pero-no-vacio") };

// ---------------------------------------------------------------------------

describe("pass.json", () => {
  it("pone al comercio como emisor y a Sophos solo en el dorso", () => {
    const p = pass();

    expect(p.organizationName).toBe("Don Julio");
    expect(JSON.stringify(p.storeCard.primaryFields)).not.toContain("Sophos");

    const emisor = p.storeCard.backFields?.find((f) => f.key === "emisor");
    expect(emisor?.value).toContain("Sophos Group EAS en nombre de Don Julio SA");
  });

  it("reserva el campo de novedades con su changeMessage", () => {
    // Es el único vehículo de notificación de Apple. Si este campo desaparece,
    // la tarjeta queda muda en iPhone y recuperarlo obliga a reemitir los pases.
    const novedades = pass().storeCard.backFields?.find((f) => f.key === NEWS_FIELD_KEY);

    expect(novedades).toBeDefined();
    expect(novedades?.changeMessage).toBe("%@");
    expect(novedades?.label).toBe("Novedades");
  });

  it("traduce los colores de hex a rgb, que es lo que pide Apple", () => {
    const p = pass();
    expect(p.backgroundColor).toBe("rgb(220, 38, 38)");
    expect(p.foregroundColor).toBe("rgb(255, 255, 255)");
    expect(p.labelColor).toBe("rgb(252, 165, 165)");
  });

  it("ignora un color inválido en vez de escribir basura en el pase", () => {
    // Un valor con formato equivocado hace que iOS rechace el pase entero. Es
    // preferible una tarjeta con el color por defecto a una que no se agrega.
    const p = buildStoreCard({
      design: { ...design, backgroundColor: "rojo" },
      merchant,
      config,
      serialNumber: "SN-0001",
      authenticationToken: TOKEN,
      balance: 0,
    });
    expect(p.backgroundColor).toBeUndefined();
  });

  it("corta las geocercas en diez, que es el tope de Apple", () => {
    const locations = Array.from({ length: 14 }, (_, i) => ({
      latitude: -25.3 + i / 100,
      longitude: -57.6,
      relevantText: `Sucursal ${i}`,
    }));

    expect(pass({ locations }).locations).toHaveLength(MAX_LOCATIONS);
  });

  it("el QR lleva el serial y nada más", () => {
    const barcode = pass().barcodes?.[0];
    expect(barcode?.message).toBe("SN-0001");
    expect(barcode?.format).toBe("PKBarcodeFormatQR");
  });

  it("hexToRgb rechaza lo que no sea hex de seis dígitos", () => {
    expect(hexToRgb("#DC2626")).toBe("rgb(220, 38, 38)");
    expect(hexToRgb("DC2626")).toBe("rgb(220, 38, 38)");
    expect(hexToRgb("#DC26")).toBeUndefined();
    expect(hexToRgb("")).toBeUndefined();
  });
});

describe("el zip que produce", () => {
  it("lo abre el unzip del sistema, con todos los archivos", () => {
    const pkpass = buildPkpass({ pass: pass(), images, material, signedAt: new Date(2026, 8, 1) });

    const dir = mkdtempSync(join(tmpdir(), "pkpass-"));
    const file = join(dir, "tarjeta.pkpass");
    writeFileSync(file, pkpass);

    // `unzip -t` verifica CRC y estructura. Si el central directory está mal,
    // acá falla — que es exactamente lo que iOS no nos diría.
    const test = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    expect(test).toContain("No errors detected");

    const listing = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" });
    expect(listing.split("\n").filter(Boolean).sort()).toEqual([
      "icon.png",
      "manifest.json",
      "pass.json",
      "signature",
    ]);

    const passJson = execFileSync("unzip", ["-p", file, "pass.json"], { encoding: "utf8" });
    expect(JSON.parse(passJson).organizationName).toBe("Don Julio");
  });

  it("devuelve los mismos bytes para el mismo contenido", () => {
    // Sin fecha fija en las entradas, dos builds del mismo pase darían archivos
    // distintos y no habría forma de comparar ni de cachear.
    const a = createZip([{ name: "a.txt", data: Buffer.from("hola") }]);
    const b = createZip([{ name: "a.txt", data: Buffer.from("hola") }]);
    expect(a.equals(b)).toBe(true);
  });
});

describe("manifiesto y firma", () => {
  it("un archivo modificado cambia el manifiesto", () => {
    const antes = buildManifest([{ name: "pass.json", data: Buffer.from("{}") }]);
    const despues = buildManifest([{ name: "pass.json", data: Buffer.from("{ }") }]);
    expect(antes.equals(despues)).toBe(false);
  });

  it("openssl valida la firma contra el manifiesto", () => {
    const manifest = buildManifest([{ name: "pass.json", data: Buffer.from("{}") }]);
    const signature = signManifest(manifest, material, new Date(2026, 8, 1));

    const dir = mkdtempSync(join(tmpdir(), "sig-"));
    writeFileSync(join(dir, "manifest.json"), manifest);
    writeFileSync(join(dir, "signature"), signature);
    writeFileSync(join(dir, "signer.pem"), material.certificatePem);

    // -noverify saltea la validación de cadena (el certificado es autofirmado),
    // pero sí comprueba criptográficamente la firma sobre el manifiesto.
    const out = execFileSync(
      "openssl",
      [
        "smime", "-verify", "-binary", "-inform", "DER",
        "-in", join(dir, "signature"),
        "-content", join(dir, "manifest.json"),
        "-certfile", join(dir, "signer.pem"),
        "-noverify",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(out).toBe(manifest.toString("utf8"));
  });

  it("la firma no valida contra un manifiesto alterado", () => {
    const manifest = buildManifest([{ name: "pass.json", data: Buffer.from("{}") }]);
    const signature = signManifest(manifest, material, new Date(2026, 8, 1));

    const dir = mkdtempSync(join(tmpdir(), "sig-mal-"));
    writeFileSync(join(dir, "manifest.json"), Buffer.from('{"pass.json":"otro"}'));
    writeFileSync(join(dir, "signature"), signature);
    writeFileSync(join(dir, "signer.pem"), material.certificatePem);

    expect(() =>
      execFileSync(
        "openssl",
        [
          "smime", "-verify", "-binary", "-inform", "DER",
          "-in", join(dir, "signature"),
          "-content", join(dir, "manifest.json"),
          "-certfile", join(dir, "signer.pem"),
          "-noverify",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toThrow();
  });

  it("la cadena incluye el WWDR, sin el cual iOS rechaza el pase", () => {
    const manifest = buildManifest([{ name: "pass.json", data: Buffer.from("{}") }]);
    const signature = signManifest(manifest, material, new Date(2026, 8, 1));

    const dir = mkdtempSync(join(tmpdir(), "cadena-"));
    writeFileSync(join(dir, "signature"), signature);

    const certs = execFileSync(
      "openssl",
      ["pkcs7", "-inform", "DER", "-in", join(dir, "signature"), "-print_certs", "-noout"],
      { encoding: "utf8" },
    );
    expect(certs).toContain("Pass Type ID");
    expect(certs).toContain("Apple Worldwide Developer Relations");
  });
});

describe("defensas al armar el paquete", () => {
  it("no arma un pase sin icon.png", () => {
    expect(() => buildPkpass({ pass: pass(), images: { "icon.png": Buffer.alloc(0) }, material })).toThrow(
      PassBuildError,
    );
  });

  it("no firma un pase con el certificado de otro comercio", () => {
    // Se genera y se firma sin error, y el teléfono lo rechaza sin decir por qué.
    // Detectarlo acá cuesta una comparación.
    const otro = { ...material, passTypeIdentifier: "pass.com.sophosgroup.l.bar-z" };
    expect(() => buildPkpass({ pass: pass(), images, material: otro })).toThrow(/bar-z/);
  });

  it("exige un authenticationToken de largo suficiente", () => {
    const corto = pass();
    corto.authenticationToken = "corto";
    expect(() => buildPkpass({ pass: corto, images, material })).toThrow(/16/);
  });
});
