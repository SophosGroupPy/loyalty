/**
 * Formas del `pass.json` de Apple. Solo los campos que usamos.
 *
 * La referencia es "Pass" en la documentación de PassKit. Se modela como tipos
 * en vez de armar objetos sueltos porque el modo de fallar de Apple es
 * particularmente malo: un campo con nombre equivocado no da error, el pase
 * simplemente no se agrega a la Wallet y el teléfono no dice por qué.
 */

/** Campo de una tarjeta. `key` es su identificador interno; `label` lo que se ve. */
export interface PassField {
  key: string;
  label?: string;
  value: string | number;
  /**
   * Texto que aparece cuando cambia el valor de este campo.
   *
   * **Es el único vehículo de notificación que tiene Apple.** No existe mandar
   * texto libre a un pase: se cambia el valor de un campo que tenga
   * `changeMessage` y el sistema muestra ese texto con `%@` reemplazado por el
   * valor nuevo. Google resuelve lo mismo con `messages[]`, que es mejor.
   */
  changeMessage?: string;
  textAlignment?: "PKTextAlignmentLeft" | "PKTextAlignmentCenter" | "PKTextAlignmentRight";
}

export interface PassBarcode {
  format: "PKBarcodeFormatQR";
  message: string;
  /**
   * `iso-8859-1` es lo que pide Apple para QR y lo que aceptan los lectores.
   * Con UTF-8 algunos escáneres devuelven basura.
   */
  messageEncoding: "iso-8859-1";
  altText?: string;
}

/**
 * Geocerca. Hasta 10 por pase, tope de Apple.
 *
 * A diferencia de Google, acá el radio lo elige el emisor con `maxDistance`, y
 * el sistema usa el menor entre ese valor y su propio default.
 */
export interface PassLocationEntry {
  latitude: number;
  longitude: number;
  /** Lo que se muestra en la pantalla bloqueada al acercarse. */
  relevantText?: string;
  maxDistance?: number;
}

export interface StoreCardFields {
  headerFields?: PassField[];
  primaryFields?: PassField[];
  secondaryFields?: PassField[];
  auxiliaryFields?: PassField[];
  backFields?: PassField[];
}

export interface ApplePass {
  formatVersion: 1;
  passTypeIdentifier: string;
  serialNumber: string;
  teamIdentifier: string;
  /** El comercio, nunca Sophos. Es lo que el cliente ve como emisor. */
  organizationName: string;
  /** Obligatorio. Lo usa VoiceOver, no se muestra en la tarjeta. */
  description: string;
  logoText?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  labelColor?: string;
  barcodes?: PassBarcode[];
  locations?: PassLocationEntry[];
  /** Endpoint del web service de actualización. Sin esto el pase nunca cambia. */
  webServiceURL?: string;
  /** Credencial que el dispositivo manda al web service. Mínimo 16 caracteres. */
  authenticationToken?: string;
  storeCard: StoreCardFields;
}

export interface AppleWalletConfig {
  /** Team ID de la cuenta de desarrollador de Sophos. */
  teamIdentifier: string;
  /** Base del web service, sin barra final. */
  webServiceURL: string;
}

/**
 * Material de firma de un comercio.
 *
 * Cada comercio tiene su propio Pass Type ID —Apple apila las tarjetas por ese
 * identificador y `groupingIdentifier` no aplica a `storeCard`— y por lo tanto
 * su propio certificado.
 */
export interface PassSigningMaterial {
  passTypeIdentifier: string;
  /** Certificado del Pass Type ID, en PEM. */
  certificatePem: string;
  /** Clave privada de ese certificado, en PEM. */
  privateKeyPem: string;
  /** Passphrase de la clave privada, si la tiene. */
  privateKeyPassphrase?: string;
  /** Intermedio Worldwide Developer Relations de Apple, en PEM. */
  wwdrCertificatePem: string;
}
