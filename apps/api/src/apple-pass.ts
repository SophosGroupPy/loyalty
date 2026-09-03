/**
 * Emisión del `.pkpass` desde la API.
 *
 * Junta lo que ya existe por separado: la tarjeta del cliente, el diseño que
 * cargó el comercio, sus geocercas y el material de firma guardado cifrado.
 */

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";
import {
  APPLE_STRIP_PX,
  shrinkPng,
  stampStrip,
  appleImagesFrom,
  buildPkpass,
  buildStoreCard,
  isPng,
  passTypeIdFor,
  solidPng,
  type AppleWalletConfig,
  type CardDesign,
  type PassImages,
} from "@sophos/passes";

import { loadSigningMaterial, passAuthToken } from "./apple.js";
import { DEFAULT_DESIGN } from "./passes.js";

export interface AppleIssuer {
  /** `false` mientras falte la clave de cifrado o el WWDR. */
  readonly enabled: boolean;
  issue(passTypeIdentifier: string, serialNumber: string): Promise<IssueResult>;
}

export type IssueResult =
  | { status: "ok"; pkpass: Buffer; updatedAt: Date }
  | { status: "not_found" }
  | { status: "no_certificate" }
  | { status: "disabled" };

interface CardRow {
  membership_id: string;
  merchant_id: string;
  merchant_slug: string;
  product_name: string;
  display_name: string;
  legal_name: string;
  design: CardDesign | null;
  serial_number: string;
  balance: number;
  tier: string | null;
  program_kind: "points" | "stamps";
  program_config: { rewardAt?: number } | null;
  member_name: string | null;
  content_updated_at: Date;
}

export interface AppleIssuerOptions {
  config: AppleWalletConfig;
  /** Clave de cifrado de las claves privadas. Sin ella no se puede firmar. */
  encryptionKey: Buffer | null;
  /** Intermedio WWDR de Apple, en PEM. */
  wwdrCertificatePem: string | null;
  signingKey: Uint8Array;
  fetchImpl?: typeof fetch;
}

/**
 * Tope del logo que se baja del comercio.
 *
 * El pase entero se descarga en el teléfono cada vez que cambia el saldo, así
 * que su peso es tráfico recurrente, no un costo de una sola vez. Un logo de
 * 5 MB haría un `.pkpass` de 5 MB que se rebaja en cada acumulación.
 *
 * 512 KB es holgado para un PNG de logo bien exportado y corta el caso patológico
 * del comercio que sube la foto de su cartel. Todavía no redimensionamos: cuando
 * la consola valide el tamaño al subirlo, este tope pasa a ser la última defensa
 * y no la única.
 */
const MAX_LOGO_BYTES = 512 * 1024;

export function createAppleIssuer(db: Db, opts: AppleIssuerOptions): AppleIssuer {
  const enabled = Boolean(opts.encryptionKey && opts.wwdrCertificatePem);
  const fetchImpl = opts.fetchImpl ?? fetch;

  /**
   * Baja el logo del comercio.
   *
   * Si falla —URL caída, no es PNG, tarda demasiado— se sigue con un cuadrado
   * del color de marca. **Sin `icon.png` iOS no agrega el pase**, así que una
   * tarjeta con el ícono genérico es mejor que ninguna tarjeta. Se registra
   * como fallback en vez de fallar en silencio.
   */
  /**
   * Baja y achica la banda de imagen. Devuelve `null` ante cualquier problema.
   *
   * No tira: una banda que no se puede bajar no es motivo para dejar al cliente
   * sin tarjeta. El pase sale sin ella, que es exactamente como salía antes.
   */
  async function loadStrip(design: CardDesign): Promise<Buffer | null> {
    if (!design.stripImageUrl) return null;
    try {
      const response = await fetchImpl(design.stripImageUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;

      const bruta = Buffer.from(await response.arrayBuffer());
      if (bruta.byteLength > MAX_LOGO_BYTES) return null;
      return shrinkPng(bruta, APPLE_STRIP_PX);
    } catch {
      return null;
    }
  }

  async function loadLogo(design: CardDesign): Promise<{ images: PassImages; fallback: boolean }> {
    const icono = solidPng(58, design.backgroundColor);

    if (!design.logoUrl) return { images: { "icon.png": icono }, fallback: true };

    try {
      const response = await fetchImpl(design.logoUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { images: { "icon.png": icono }, fallback: true };

      const logo = Buffer.from(await response.arrayBuffer());

      if (logo.length > MAX_LOGO_BYTES) {
        return { images: { "icon.png": icono }, fallback: true };
      }

      if (!isPng(logo)) {
        // Apple solo acepta PNG. Un JPG con nombre .png se agrega igual al zip
        // y el pase se rechaza en el teléfono sin explicación.
        return { images: { "icon.png": icono }, fallback: true };
      }

      // Se reduce a las medidas de Apple en vez de mandar el original. Un logo
      // de 1024x1024 deja un pase de 337 KB que el teléfono rebaja entero en
      // cada cambio de saldo.
      try {
        const { icon, logo: chico } = appleImagesFrom(logo);
        return { images: { "icon.png": icon, "logo.png": chico }, fallback: false };
      } catch {
        // El PNG se leyó como PNG pero no se pudo decodificar. Es preferible el
        // ícono genérico a un pase que iOS rechaza.
        return { images: { "icon.png": icono }, fallback: true };
      }
    } catch {
      return { images: { "icon.png": icono }, fallback: true };
    }
  }

  /**
   * Junta las imágenes del pase.
   *
   * La banda se resuelve **aparte del logo** a propósito: son dos imágenes
   * independientes y un comercio puede perfectamente cargar la foto de su local
   * sin haber subido un logo. Cuando esto vivía adentro de la rama del logo, ese
   * comercio se quedaba sin banda y sin ningún error que lo explicara.
   */
  async function loadImages(design: CardDesign): Promise<{ images: PassImages; fallback: boolean }> {
    const base = await loadLogo(design);

    const banda = await loadStrip(design);
    if (banda) base.images["strip.png"] = banda;

    return base;
  }

  return {
    enabled,

    async issue(passTypeIdentifier, serialNumber) {
      if (!enabled) return { status: "disabled" };

      const found = await rows<CardRow>(
        db.drizzle,
        sql`SELECT m.id AS membership_id, m.merchant_id, m.serial_number, m.balance, m.tier,
                   mer.slug AS merchant_slug, mer.display_name, mer.legal_name, mer.design,
                   prod.name AS product_name,
                   p.kind AS program_kind, p.config AS program_config,
                   m.display_name AS member_name,
                   COALESCE(pi.content_updated_at, m.issued_at) AS content_updated_at
            FROM membership m
            JOIN merchant mer ON mer.id = m.merchant_id
            JOIN product prod ON prod.id = mer.product_id
            JOIN program p ON p.id = m.program_id
            LEFT JOIN pass_instance pi
              ON pi.membership_id = m.id AND pi.platform = 'apple'
            WHERE m.serial_number = ${serialNumber} AND m.status = 'active'`,
      );

      const card = found[0];
      if (!card) return { status: "not_found" };

      // El Pass Type ID que pide el dispositivo tiene que ser el de este
      // comercio: si no, alguien está pidiendo un pase con la ruta de otro.
      if (passTypeIdFor(card.merchant_slug) !== passTypeIdentifier) {
        return { status: "not_found" };
      }

      const material = await loadSigningMaterial(
        db,
        passTypeIdentifier,
        opts.encryptionKey!,
        opts.wwdrCertificatePem!,
      );
      if (!material) return { status: "no_certificate" };

      const design: CardDesign = {
        ...DEFAULT_DESIGN,
        ...(card.design ?? {}),
        balanceLabel:
          card.design?.balanceLabel ?? (card.program_kind === "stamps" ? "Sellos" : "Puntos"),
        // Se resuelve del producto dueño del comercio, no fija: la misma API
        // sirve a elMenú, Noctu y FactuFast.
        attribution: card.design?.attribution ?? `Powered by ${card.product_name}`,
      };

      const locations = await rows<{ latitude: number; longitude: number; relevant_text: string | null }>(
        db.drizzle,
        sql`SELECT latitude, longitude, relevant_text FROM merchant_location
            WHERE merchant_id = ${card.merchant_id} ORDER BY created_at LIMIT 10`,
      );

      const { images } = await loadImages(design);

      // La banda de un programa de sellos se **dibuja**, no se sube.
      //
      // Los sellos tienen que verse como casilleros, y Apple no deja dibujar
      // nada: la única superficie libre del pase es esta imagen. Así que la foto
      // que cargó el comercio pasa a ser el fondo y los sellos se rinden encima,
      // de nuevo en cada descarga — que es también cada vez que el saldo cambia.
      //
      // Un programa de puntos no lleva casilleros: ahí la foto va tal cual, que
      // es lo que ya hacía `loadImages`.
      const rewardAt =
        card.program_kind === "stamps" ? (card.program_config?.rewardAt ?? 0) : 0;

      if (card.program_kind === "stamps") {
        if (rewardAt > 0) {
          try {
            images["strip.png"] = stampStrip({
              total: rewardAt,
              earned: card.balance,
              background: images["strip.png"] ?? null,
              backgroundColor: design.backgroundColor,
              // El sello lleno usa el color del texto, que es el que el comercio
              // ya eligió para que contraste con su fondo.
              ...(design.foregroundColor ? { accentColor: design.foregroundColor } : {}),
            });
          } catch {
            // Se deja la banda que hubiera: una tarjeta sin casilleros es peor
            // que una con casilleros, pero mucho mejor que ninguna tarjeta.
          }
        }
      }

      const pass = buildStoreCard({
        design,
        merchant: {
          slug: card.merchant_slug,
          displayName: card.display_name,
          legalName: card.legal_name,
        },
        config: opts.config,
        serialNumber: card.serial_number,
        authenticationToken: passAuthToken(card.serial_number, opts.signingKey),
        balance: card.balance,
        ...(card.tier ? { tier: card.tier } : {}),
        ...(card.member_name ? { memberName: card.member_name } : {}),
        ...(rewardAt > 0 ? { stampsTarget: rewardAt } : {}),
        locations: locations.map((l) => ({
          latitude: l.latitude,
          longitude: l.longitude,
          ...(l.relevant_text ? { relevantText: l.relevant_text } : {}),
        })),
      });

      return {
        status: "ok",
        pkpass: buildPkpass({ pass, images, material }),
        updatedAt: new Date(card.content_updated_at),
      };
    },
  };
}

/**
 * Configuración de Apple Wallet desde el entorno.
 *
 * Devuelve `null` si falta lo mínimo. Sin esto el servidor sigue funcionando
 * entero: se registran dispositivos y se emite en Android, y solo la emisión
 * de pases de iPhone responde 503 con motivo explícito.
 */
export function appleWalletConfigFromEnv(): {
  teamIdentifier: string;
  webServiceURL: string;
  encryptionKey?: string;
  wwdrCertificatePem?: string;
} | null {
  const teamIdentifier = process.env.APPLE_TEAM_ID;
  const webServiceURL = process.env.APPLE_WEB_SERVICE_URL;

  if (!teamIdentifier || !webServiceURL) return null;

  return {
    teamIdentifier,
    webServiceURL,
    // Los `\n` escapados son lo que sale de copiar un PEM a una variable de
    // entorno; se aceptan tal cual, igual que con la clave de Google.
    ...(process.env.APPLE_WWDR_PEM
      ? { wwdrCertificatePem: process.env.APPLE_WWDR_PEM.replace(/\\n/g, "\n") }
      : {}),
    ...(process.env.APPLE_PASS_ENCRYPTION_KEY
      ? { encryptionKey: process.env.APPLE_PASS_ENCRYPTION_KEY }
      : {}),
  };
}


/**
 * Credenciales de la App Store Connect API desde el entorno.
 *
 * Sin esto, el alta de un comercio sigue siendo manual: se genera el CSR a mano,
 * se registra el Pass Type ID en el portal y se sube el certificado por la
 * consola. Funciona, pero son seis pasos por comercio y otros tantos al renovar.
 */
export function ascConfigFromEnv(): {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
} | null {
  const keyId = process.env.APPLE_ASC_KEY_ID;
  const issuerId = process.env.APPLE_ASC_ISSUER_ID;
  const privateKeyPem = process.env.APPLE_ASC_PRIVATE_KEY;

  if (!keyId || !issuerId || !privateKeyPem) return null;

  // Los `\n` escapados son lo que sale de pegar un .p8 en una variable de
  // entorno, igual que con la clave de Google y el WWDR.
  return { keyId, issuerId, privateKeyPem: privateKeyPem.replace(/\\n/g, "\n") };
}
