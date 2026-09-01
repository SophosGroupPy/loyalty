/**
 * Emite un `.pkpass` real, firmado con el certificado de Don Julio.
 *
 * Es la prueba de que la capa entera funciona: construcción, manifiesto, firma
 * con material de Apple de verdad, y zip. Lo único que no puede verificar es si
 * el iPhone lo acepta — eso necesita un teléfono.
 */

import { deflateSync, crc32 } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

import { buildPkpass, buildStoreCard } from "@sophos/passes";
import type { AppleWalletConfig, PassSigningMaterial } from "@sophos/passes";

/** PNG de un color sólido, escrito a mano para no arrastrar una dependencia. */
function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // color type 2 = RGB
  const raw = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from(rgb)))]),
    ),
  );

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const material: PassSigningMaterial = {
  passTypeIdentifier: "pass.com.sophosgroup.l.don-julio",
  certificatePem: readFileSync("certs/don-julio/certificate.pem", "utf8"),
  privateKeyPem: readFileSync("certs/don-julio/private.key", "utf8"),
  wwdrCertificatePem: readFileSync("certs/wwdr.pem", "utf8"),
};

const config: AppleWalletConfig = {
  teamIdentifier: "3W23SYPG6H",
  webServiceURL: "https://tarjeta.sophosgroup.com.py",
};

const pass = buildStoreCard({
  design: {
    programName: "Puntos Don Julio",
    logoUrl: "",
    backgroundColor: "#DC2626",
    balanceLabel: "Puntos",
    newsLabel: "Novedades",
    foregroundColor: "#FFFFFF",
    labelColor: "#FCA5A5",
    logoText: "Don Julio",
  },
  merchant: { slug: "don-julio", displayName: "Don Julio", legalName: "Don Julio SA" },
  config,
  serialNumber: "SN-DEMO-0001",
  authenticationToken: "token-de-demo-de-32-caracteres-ok",
  balance: 340,
  tier: "Oro",
  news: "2x1 en la barra hasta las 12",
  locations: [
    { latitude: -25.2837, longitude: -57.5759, relevantText: "Tenés 340 puntos en Don Julio" },
  ],
});

const pkpass = buildPkpass({
  pass,
  images: {
    "icon.png": solidPng(29, [220, 38, 38]),
    "icon@2x.png": solidPng(58, [220, 38, 38]),
    "logo.png": solidPng(50, [255, 255, 255]),
  },
  material,
});

writeFileSync("certs/don-julio/don-julio.pkpass", pkpass);
console.log(`.pkpass emitido: ${pkpass.length} bytes`);
console.log(`passTypeIdentifier: ${pass.passTypeIdentifier}`);
console.log(`teamIdentifier:     ${pass.teamIdentifier}`);
console.log(`organizationName:   ${pass.organizationName}`);
