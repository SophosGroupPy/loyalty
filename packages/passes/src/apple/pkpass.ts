/**
 * Armado del `.pkpass`.
 *
 * Junta el `pass.json`, las imágenes, el manifiesto y la firma en un zip. El
 * orden importa: el manifiesto tiene que cubrir todos los archivos y la firma
 * tiene que ser del manifiesto ya completo, así que se arma al final.
 */

import type { ApplePass } from "./types.js";
import type { PassSigningMaterial } from "./types.js";
import { buildManifest, signManifest, type PassFile } from "./sign.js";
import { createZip } from "./zip.js";

/**
 * Imágenes del pase.
 *
 * `icon.png` es **obligatorio**: sin él iOS rechaza el pase sin explicar nada.
 * Es la imagen que aparece en las notificaciones y en la pantalla bloqueada, no
 * el logo de la tarjeta.
 */
export interface PassImages {
  "icon.png": Buffer;
  "icon@2x.png"?: Buffer;
  "logo.png"?: Buffer;
  "logo@2x.png"?: Buffer;
  "strip.png"?: Buffer;
  "strip@2x.png"?: Buffer;
}

export class PassBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassBuildError";
  }
}

export interface PkpassInput {
  pass: ApplePass;
  images: PassImages;
  material: PassSigningMaterial;
  /** Fecha de firma. Se inyecta en los tests para que el resultado sea estable. */
  signedAt?: Date;
}

export function buildPkpass(input: PkpassInput): Buffer {
  if (!input.images["icon.png"] || input.images["icon.png"].length === 0) {
    throw new PassBuildError(
      "Falta icon.png. Sin ese archivo iOS rechaza el pase sin dar motivo.",
    );
  }

  if (input.pass.passTypeIdentifier !== input.material.passTypeIdentifier) {
    // El certificado firma para un Pass Type ID concreto. Si no coinciden, el
    // pase se genera bien, se firma bien, y el teléfono lo rechaza al agregarlo.
    // Verificarlo acá cuesta una línea; diagnosticarlo en un iPhone, una tarde.
    throw new PassBuildError(
      `El pase declara ${input.pass.passTypeIdentifier} pero el certificado es de ` +
        `${input.material.passTypeIdentifier}.`,
    );
  }

  if ((input.pass.authenticationToken?.length ?? 0) < 16) {
    throw new PassBuildError(
      "authenticationToken tiene que tener al menos 16 caracteres; es lo que pide Apple.",
    );
  }

  const files: PassFile[] = [
    { name: "pass.json", data: Buffer.from(JSON.stringify(input.pass), "utf8") },
    ...Object.entries(input.images)
      .filter(([, data]) => data && data.length > 0)
      .map(([name, data]) => ({ name, data: data as Buffer })),
  ];

  const manifest = buildManifest(files);
  const signature = signManifest(manifest, input.material, input.signedAt);

  return createZip([
    ...files,
    { name: "manifest.json", data: manifest },
    { name: "signature", data: signature },
  ]);
}
