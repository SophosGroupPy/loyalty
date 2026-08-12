/**
 * Tipos de la capa de pases.
 *
 * `CardDesign` es exactamente lo que el comercio configura en la sección
 * "Diseño" de la consola. Es un formulario, no un lienzo libre: el formato de
 * pase es rígido en las dos plataformas y esa expectativa hay que gestionarla
 * al vender el módulo, no cuando el comercio pide mover un texto.
 */

export interface CardDesign {
  /** Nombre del programa como lo ve el cliente: "Puntos Don Julio". */
  programName: string;
  /** Logo del comercio. Tiene que ser una URL pública y estable. */
  logoUrl: string;
  /** Imagen de cabecera, opcional. */
  heroImageUrl?: string;
  /** Color de fondo en hex, por ejemplo "#DC2626". */
  backgroundColor: string;
  /** Etiqueta del saldo: "Puntos", "Sellos". */
  balanceLabel: string;
  /**
   * Etiqueta del campo de novedades.
   *
   * **Lo consume el constructor de Apple, no el de Google.** En Apple no se
   * puede mandar texto libre: la única forma de notificar es cambiar el valor de
   * un campo que tenga `changeMessage`, así que hace falta un campo reservado
   * para eso. Google resuelve lo mismo con `messages[]`, que es mejor.
   *
   * Se reserva desde el día uno igual: agregarlo después obliga a reemitir
   * todos los pases de Apple.
   */
  newsLabel: string;
}

/**
 * Identidad del comercio tal como aparece en la tarjeta.
 *
 * El cliente ve al comercio, nunca a Sophos. La atribución de Sophos va en el
 * dorso, que es lo que exige el mandato con el que se firman los pases.
 */
export interface MerchantIdentity {
  /** Identificador estable para armar el id de la clase. */
  slug: string;
  /** Nombre comercial. Es lo que ve el cliente. */
  displayName: string;
  /** Razón social, para la atribución del dorso. */
  legalName: string;
}

/**
 * Punto que dispara la aparición de la tarjeta al acercarse.
 *
 * En Google el radio **lo fija Google** y no es configurable — a diferencia de
 * Apple, donde `maxDistance` se elige por pase.
 */
export interface PassLocation {
  latitude: number;
  longitude: number;
  /** Referencia interna del local. Google no la muestra. */
  label?: string;
}

/** Mensaje de campaña. Se traduce distinto en cada plataforma. */
export interface PassMessage {
  id: string;
  header: string;
  body: string;
  /** `true` agrega el mensaje y notifica; `false` solo lo agrega. */
  notify: boolean;
}

export interface GoogleWalletConfig {
  /** Issuer ID que asigna Google a Sophos. */
  issuerId: string;
  /** Email de la service account de GCP. */
  serviceAccountEmail: string;
  /** Clave privada de la service account, en PEM PKCS#8. */
  privateKeyPem: string;
  /** Dominios autorizados a mostrar el botón de guardado. */
  origins: string[];
}

// ---------------------------------------------------------------------------
// Formas de la API de Google. Solo los campos que usamos.
// ---------------------------------------------------------------------------

export interface GoogleTextModule {
  id: string;
  header: string;
  body: string;
}

export interface GoogleLoyaltyClass {
  id: string;
  issuerName: string;
  programName: string;
  programLogo: { sourceUri: { uri: string } };
  reviewStatus: string;
  hexBackgroundColor?: string;
  heroImage?: { sourceUri: { uri: string } };
  textModulesData?: GoogleTextModule[];
  /** Reemplaza a `locations`, que está deprecado y ya no dispara geo-notificaciones. */
  merchantLocations?: { latitude: number; longitude: number }[];
  notifyPreference?: string;
}

export interface GoogleLoyaltyObject {
  id: string;
  classId: string;
  state: string;
  accountId?: string;
  accountName?: string;
  loyaltyPoints?: { label: string; balance: { int: number } };
  secondaryLoyaltyPoints?: { label: string; balance: { int: number } };
  barcode?: { type: string; value: string; alternateText?: string };
  textModulesData?: GoogleTextModule[];
  messages?: { id: string; header: string; body: string; messageType: string }[];
  notifyPreference?: string;
}
