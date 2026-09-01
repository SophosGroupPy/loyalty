/**
 * Emisión del `.pkpass` desde la API.
 *
 * Junta lo que ya existe por separado: la tarjeta del cliente, el diseño que
 * cargó el comercio, sus geocercas y el material de firma guardado cifrado.
 */

import { sql } from "drizzle-orm";

import { rows, type Db } from "@sophos/db";
import {
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
  display_name: string;
  legal_name: string;
  design: CardDesign | null;
  serial_number: string;
  balance: number;
  tier: string | null;
  program_kind: "points" | "stamps";
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
  async function loadImages(design: CardDesign): Promise<{ images: PassImages; fallback: boolean }> {
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

  return {
    enabled,

    async issue(passTypeIdentifier, serialNumber) {
      if (!enabled) return { status: "disabled" };

      const found = await rows<CardRow>(
        db.drizzle,
        sql`SELECT m.id AS membership_id, m.merchant_id, m.serial_number, m.balance, m.tier,
                   mer.slug AS merchant_slug, mer.display_name, mer.legal_name, mer.design,
                   p.kind AS program_kind,
                   COALESCE(pi.content_updated_at, m.issued_at) AS content_updated_at
            FROM membership m
            JOIN merchant mer ON mer.id = m.merchant_id
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
      };

      const locations = await rows<{ latitude: number; longitude: number; relevant_text: string | null }>(
        db.drizzle,
        sql`SELECT latitude, longitude, relevant_text FROM merchant_location
            WHERE merchant_id = ${card.merchant_id} ORDER BY created_at LIMIT 10`,
      );

      const { images } = await loadImages(design);

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
