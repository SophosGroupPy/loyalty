/**
 * Construcción del `pass.json` a partir del mismo diseño que consume Google.
 *
 * El comercio configura una sola vez en la consola y las dos plataformas leen
 * de ahí. Lo que cambia es lo que cada una necesita de más, no el modelo.
 */

import type { CardDesign, MerchantIdentity, PassLocation } from "../google/types.js";
import { mesYAnio } from "../format.js";
import type {
  ApplePass,
  AppleWalletConfig,
  PassField,
  PassLocationEntry,
} from "./types.js";

/** Tope de geocercas por pase. Lo fija Apple y no es negociable. */
export const MAX_LOCATIONS = 10;

/**
 * Radio por defecto de la geocerca, en metros.
 *
 * Apple usa el menor entre este valor y su propio default. 100 m cubre la
 * vereda del local sin dispararse con quien apenas pasa por la cuadra.
 */
export const DEFAULT_MAX_DISTANCE = 100;

/** Clave del campo reservado de novedades. Ver `newsFieldFor`. */
export const NEWS_FIELD_KEY = "novedades";

/**
 * Apple quiere los colores como `rgb(r, g, b)`, no como hex.
 *
 * La consola guarda hex porque es lo que entiende Google y lo que el comercio
 * pega desde su manual de marca. La conversión va acá y no en la consola: es un
 * requisito del formato de Apple, no una decisión de producto.
 */
export function hexToRgb(hex: string): string | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;

  const value = parseInt(match[1]!, 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
}

/** Pass Type ID de un comercio. Uno por comercio, ver `types.ts`. */
export function passTypeIdFor(slug: string): string {
  return `pass.com.sophosgroup.l.${slug.replace(/[^a-z0-9-]/gi, "").toLowerCase()}`;
}

/**
 * El campo reservado por el que viajan las notificaciones.
 *
 * `changeMessage: "%@"` hace que iOS muestre el valor nuevo tal cual cuando
 * cambia. Va en el dorso para no comerse el frente, que es donde tienen que
 * estar el saldo y el nivel; la notificación se dispara igual, no depende de
 * dónde esté el campo.
 *
 * **No se puede quitar.** Sin él la tarjeta queda muda en iPhone: no hay otra
 * forma de notificar. Y agregarlo después obliga a reemitir todos los pases.
 */
export function newsFieldFor(design: CardDesign, value: string): PassField {
  return {
    key: NEWS_FIELD_KEY,
    label: design.newsLabel,
    value,
    changeMessage: "%@",
  };
}

export interface BuildPassInput {
  design: CardDesign;
  merchant: MerchantIdentity;
  config: AppleWalletConfig;
  serialNumber: string;
  /** Credencial del pase para el web service. Mínimo 16 caracteres. */
  authenticationToken: string;
  balance: number;
  /** Etiqueta del nivel, si el programa tiene niveles. */
  tier?: string;
  /** Último mensaje mostrado en el campo de novedades. */
  news?: string;
  /** Nombre de la persona, como lo conoce este comercio. Va arriba a la derecha. */
  memberName?: string;
  /**
   * Sellos que pide el premio. Presente solo en programas de sellos.
   *
   * Cambia el frente de la tarjeta: el saldo pasa de "3" a "3 de 10". Un número
   * suelto no dice nada cuando lo que importa es cuánto falta.
   */
  stampsTarget?: number;
  /**
   * Fecha de alta, en ISO. Se muestra como "Cliente desde <mes> <año>".
   *
   * Llena la última ranura de la tarjeta y comunica antigüedad, que en un
   * programa de fidelidad es justo lo que se quiere reconocer. Una tarjeta con
   * las cuatro ranuras usadas se ve terminada; una con dos, a medio hacer.
   */
  memberSince?: string;
  locations?: (PassLocation & { relevantText?: string })[];
}


export function buildStoreCard(input: BuildPassInput): ApplePass {
  const { design, merchant, config } = input;

  const backFields: PassField[] = [
    newsFieldFor(design, input.news ?? "Sin novedades por ahora."),
    {
      key: "emisor",
      label: "Emisor",
      // El mandato con el que Sophos firma en nombre del comercio exige que la
      // relación esté declarada en el pase. Va en el dorso: el cliente ve al
      // comercio en la cara de la tarjeta, y a Sophos solo si lo da vuelta.
      value: `Emitido por Sophos Group EAS en nombre de ${merchant.legalName}.`,
    },
    {
      key: "baja",
      label: "Tus datos",
      value:
        "Podés apagar los avisos, darte de baja o pedir el borrado de tus datos " +
        `desde ${config.webServiceURL.replace(/\/+$/, "")}/c/${input.serialNumber}`,
    },
  ];

  /**
   * El nivel va arriba a la derecha, en la ranura de cabecera.
   *
   * Es la posición donde Air Europa pone "SUMA" y los bancos el tipo de tarjeta:
   * el ojo la lee como un distintivo de estatus, que es exactamente lo que un
   * nivel es. Antes iba en el cuerpo, compitiendo con el saldo; acá reconoce sin
   * estorbar. Si el programa no tiene niveles, la ranura queda libre y Apple no
   * dibuja nada.
   */
  const headerFields: PassField[] = input.tier
    ? [{ key: "nivel", label: "Nivel", value: input.tier }]
    : [];

  /**
   * El nombre de la persona y su antigüedad, en el cuerpo.
   *
   * Son las dos ranuras que separan una tarjeta de un cupón: la vuelven suya. Es
   * la diferencia entre la tarjeta que se veía a medio hacer —solo un número
   * sobre un fondo de color— y una que se siente completa, con las cuatro
   * ranuras usadas.
   *
   * El nombre va entero, no solo el primero: acá hay ancho de sobra, y "Diego
   * Castro Gonzales" es cómo la persona se reconoce. Apple lo corta si no entra.
   */
  const esSellos = (input.stampsTarget ?? 0) > 0;

  /**
   * El nombre de la persona y su antigüedad. Dónde van depende del programa.
   *
   * Son las dos ranuras que separan una tarjeta de un cupón: la vuelven suya. El
   * nombre va entero, no solo el primero: acá hay ancho de sobra, y "Diego Castro
   * Gonzales" es cómo la persona se reconoce. Apple lo corta si no entra.
   */
  const datosCliente: PassField[] = [];
  if (input.memberName?.trim()) {
    datosCliente.push({ key: "cliente", label: "Cliente", value: input.memberName.trim() });
  }
  const desde = input.memberSince ? mesYAnio(input.memberSince) : null;
  if (desde) {
    // Solo "Desde", no "Cliente desde": el campo de al lado ya dice "Cliente",
    // y repetir la palabra en las dos ranuras contiguas se lee como un error.
    datosCliente.push({ key: "desde", label: "Desde", value: desde });
  }

  /**
   * El saldo. En sellos se muestra como "3 de 10": el número solo obliga a
   * recordar cuántos faltan, y nadie lo recuerda.
   */
  const saldo: PassField = esSellos
    ? { key: "saldo", label: design.balanceLabel, value: `${input.balance} de ${input.stampsTarget}` }
    : { key: "saldo", label: design.balanceLabel, value: input.balance };

  const pass: ApplePass = {
    formatVersion: 1,
    passTypeIdentifier: passTypeIdFor(merchant.slug),
    serialNumber: input.serialNumber,
    teamIdentifier: config.teamIdentifier,
    organizationName: merchant.displayName,
    description: `${design.programName} — ${merchant.displayName}`,
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: input.serialNumber,
        messageEncoding: "iso-8859-1",
        // Se renderiza justo debajo del código.
        ...(design.attribution ? { altText: design.attribution } : {}),
      },
    ],
    // Apple le agrega `/v1/devices/...` a esta base por su cuenta, así que acá
    // va solo el prefijo. Si se escribiera `/v1/apple`, el teléfono terminaría
    // pidiendo `/v1/apple/v1/devices/...`. Y queda fuera de `/v1/` a propósito:
    // ese prefijo exige token de producto, y quien llama es un iPhone.
    webServiceURL: `${config.webServiceURL.replace(/\/+$/, "")}/apple`,
    authenticationToken: input.authenticationToken,
    // En sellos, los casilleros SON la banda, y Apple dibuja los primaryFields
    // ENCIMA de la banda: un "2 de 10" en primary choca con los sellos. Por eso
    // en sellos la banda queda limpia y la cuenta baja al cuerpo (secondary), con
    // el cliente debajo (auxiliary). En puntos no hay casilleros, así que el
    // número va grande sobre la foto —estilo Air Europa— y el cliente en secondary.
    storeCard: esSellos
      ? {
          ...(headerFields.length > 0 ? { headerFields } : {}),
          secondaryFields: [saldo],
          ...(datosCliente.length > 0 ? { auxiliaryFields: datosCliente } : {}),
          backFields,
        }
      : {
          ...(headerFields.length > 0 ? { headerFields } : {}),
          primaryFields: [saldo],
          ...(datosCliente.length > 0 ? { secondaryFields: datosCliente } : {}),
          backFields,
        },
  };

  if (design.logoText) pass.logoText = design.logoText;

  const background = hexToRgb(design.backgroundColor);
  if (background) pass.backgroundColor = background;

  // Apple exige que el emisor elija el color del texto; si no se manda, usa
  // negro. Sobre un fondo oscuro eso deja la tarjeta ilegible, y a diferencia
  // de Google acá nadie corrige el contraste por nosotros.
  const foreground = design.foregroundColor ? hexToRgb(design.foregroundColor) : undefined;
  if (foreground) pass.foregroundColor = foreground;

  const label = design.labelColor ? hexToRgb(design.labelColor) : undefined;
  if (label) pass.labelColor = label;

  const locations = (input.locations ?? []).slice(0, MAX_LOCATIONS).map(
    (location): PassLocationEntry => ({
      latitude: location.latitude,
      longitude: location.longitude,
      maxDistance: DEFAULT_MAX_DISTANCE,
      ...(location.relevantText ? { relevantText: location.relevantText } : {}),
    }),
  );
  if (locations.length > 0) pass.locations = locations;

  return pass;
}
