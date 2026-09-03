/**
 * Constructores de los payloads de Google Wallet.
 *
 * Funciones puras: entra la configuración del comercio, sale el JSON que espera
 * la API. Así se pueden testear enteras sin credenciales ni red.
 */

import {
  BARCODE_TYPE_QR,
  MESSAGE_TYPE_TEXT,
  MESSAGE_TYPE_TEXT_AND_NOTIFY,
  NOTIFY_PREFERENCE_ON_UPDATE,
  REVIEW_STATUS_UNDER_REVIEW,
  STATE_ACTIVE,
  STATE_INACTIVE,
} from "./enums.js";
import { mesYAnio } from "../format.js";
import type {
  CardDesign,
  GoogleLoyaltyClass,
  GoogleLoyaltyObject,
  GoogleTextModule,
  MerchantIdentity,
  PassLocation,
  PassMessage,
} from "./types.js";

/**
 * Los ids de Google solo admiten alfanuméricos, punto, guion y guion bajo.
 * Cualquier otra cosa hace que la API rechace la clase entera.
 */
export function sanitizeIdSegment(value: string): string {
  const cleaned = value
    .normalize("NFD")
    // Quita las marcas diacríticas que la descomposición NFD dejó sueltas, para
    // que "Bar Ñandutí" produzca "Bar-Nanduti" y no un id lleno de guiones.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!cleaned) throw new Error(`No queda un identificador válido de "${value}"`);
  return cleaned;
}

export function classIdFor(issuerId: string, merchantSlug: string): string {
  return `${issuerId}.${sanitizeIdSegment(merchantSlug)}`;
}

export function objectIdFor(issuerId: string, serialNumber: string): string {
  return `${issuerId}.${sanitizeIdSegment(serialNumber)}`;
}

/** Máximo de ubicaciones que se mandan. Google no documenta un tope; Apple sí (10). */
const MAX_LOCATIONS = 10;

export interface BuildClassInput {
  issuerId: string;
  merchant: MerchantIdentity;
  design: CardDesign;
  locations?: PassLocation[];
  /** `true` en las actualizaciones que deban notificar al cliente. */
  notify?: boolean;
}

export function buildLoyaltyClass(input: BuildClassInput): GoogleLoyaltyClass {
  const { issuerId, merchant, design } = input;

  const loyaltyClass: GoogleLoyaltyClass = {
    id: classIdFor(issuerId, merchant.slug),
    // El cliente ve al comercio, no a Sophos. Es lo que hace que la tarjeta se
    // sienta del bar y no de un proveedor que no conoce.
    issuerName: merchant.displayName,
    programName: design.programName,
    programLogo: { sourceUri: { uri: design.logoUrl } },
    reviewStatus: REVIEW_STATUS_UNDER_REVIEW,
    hexBackgroundColor: design.backgroundColor,
    textModulesData: [
      {
        id: "emisor",
        header: "Emisor",
        // Exigido por el mandato con el que Sophos firma pases en nombre del
        // comercio: el pase declara en el dorso quién lo emite y por cuenta de quién.
        body: `Emitido por Sophos Group EAS en nombre de ${merchant.legalName}.`,
      },
    ],
  };

  if (design.heroImageUrl) {
    loyaltyClass.heroImage = { sourceUri: { uri: design.heroImageUrl } };
  }

  if (input.locations?.length) {
    // `locations` quedó deprecado y Google documenta que ya no dispara
    // geo-notificaciones. `merchantLocations` es el reemplazo.
    loyaltyClass.merchantLocations = input.locations
      .slice(0, MAX_LOCATIONS)
      .map(({ latitude, longitude }) => ({ latitude, longitude }));
  }

  if (input.notify) loyaltyClass.notifyPreference = NOTIFY_PREFERENCE_ON_UPDATE;

  return loyaltyClass;
}

export interface BuildObjectInput {
  issuerId: string;
  merchantSlug: string;
  /** Serial de la tarjeta: es lo que va en el QR. */
  serialNumber: string;
  /** Nombre del cliente tal como lo conoce ESTE comercio. */
  accountName?: string | null;
  balance: number;
  balanceLabel: string;
  /** Línea debajo del QR. Ver `CardDesign.attribution`. */
  attribution?: string;
  tier?: string | null;
  /** Fecha de alta en ISO. Se muestra como un módulo "Cliente desde <mes> <año>". */
  memberSince?: string | null;
  messages?: PassMessage[];
  active?: boolean;
  /**
   * `true` para pedir notificación al cliente.
   *
   * Solo tiene efecto si además cambió `loyaltyPoints.balance`: en Google un
   * cambio de nivel por sí solo no dispara push. Para avisar "subiste a Oro" hay
   * que mandarlo como mensaje.
   */
  notify?: boolean;
}

export function buildLoyaltyObject(input: BuildObjectInput): GoogleLoyaltyObject {
  const { issuerId, serialNumber } = input;

  const object: GoogleLoyaltyObject = {
    id: objectIdFor(issuerId, serialNumber),
    classId: classIdFor(issuerId, input.merchantSlug),
    state: input.active === false ? STATE_INACTIVE : STATE_ACTIVE,
    accountId: serialNumber,
    loyaltyPoints: {
      label: input.balanceLabel,
      balance: { int: input.balance },
    },
    barcode: {
      type: BARCODE_TYPE_QR,
      // El serial identifica pero no autoriza: toda acumulación y todo canje se
      // validan server-side. Por eso puede ser estático y no importa que alguien
      // comparta una captura de su tarjeta.
      value: serialNumber,
      // La atribución en vez del serial: el número ya está adentro del código y
      // a nadie le sirve leerlo, mientras que esta línea es el único lugar de
      // la cara del pase donde entra texto libre.
      alternateText: input.attribution ?? serialNumber,
    },
  };

  if (input.accountName) object.accountName = input.accountName;

  // Nivel y antigüedad, como módulos de texto. Google los apila bajo los puntos:
  // llenan la tarjeta igual que las ranuras extra del lado de Apple.
  const modulos: GoogleTextModule[] = [];
  if (input.tier) modulos.push({ id: "nivel", header: "Nivel", body: input.tier });
  const desde = input.memberSince ? mesYAnio(input.memberSince) : null;
  // "Desde" a secas: el módulo de al lado ya dice "Cliente".
  if (desde) modulos.push({ id: "desde", header: "Desde", body: desde });
  if (modulos.length) object.textModulesData = modulos;

  if (input.messages?.length) {
    object.messages = input.messages.map((message) => ({
      id: message.id,
      header: message.header,
      body: message.body,
      messageType: message.notify
        ? MESSAGE_TYPE_TEXT_AND_NOTIFY
        : MESSAGE_TYPE_TEXT,
    }));
  }

  if (input.notify) object.notifyPreference = NOTIFY_PREFERENCE_ON_UPDATE;

  return object;
}
