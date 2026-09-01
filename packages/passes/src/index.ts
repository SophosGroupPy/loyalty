export {
  buildLoyaltyClass,
  buildLoyaltyObject,
  classIdFor,
  objectIdFor,
  sanitizeIdSegment,
} from "./google/build.js";
export type { BuildClassInput, BuildObjectInput } from "./google/build.js";

export { createGoogleWalletClient, GoogleWalletError } from "./google/client.js";
export type { GoogleWalletClient } from "./google/client.js";

export { buildSaveLink, createTokenProvider } from "./google/jwt.js";
export type { SaveLinkInput } from "./google/jwt.js";

export {
  NOTIFICATIONS_PER_PASS_PER_DAY,
  NOTIFY_PREFERENCE_ON_UPDATE,
  SAVE_LINK_BASE,
} from "./google/enums.js";

export type {
  CardDesign,
  GoogleLoyaltyClass,
  GoogleLoyaltyObject,
  GoogleWalletConfig,
  MerchantIdentity,
  PassLocation,
  PassMessage,
} from "./google/types.js";

// ---------------------------------------------------------------------------
// Apple. Entra como un segundo emisor detrás de la misma interfaz, no como una
// rama paralela: el diseño y la identidad del comercio se comparten, y lo único
// propio de cada plataforma es cómo se materializa el pase.
// ---------------------------------------------------------------------------

export {
  buildStoreCard,
  buildPkpass,
  buildManifest,
  signManifest,
  createZip,
  hexToRgb,
  newsFieldFor,
  passTypeIdFor,
  PassBuildError,
  PassSigningError,
  DEFAULT_MAX_DISTANCE,
  MAX_LOCATIONS,
  NEWS_FIELD_KEY,
  isPng,
  solidPng,
} from "./apple/index.js";

export type {
  ApplePass,
  AppleWalletConfig,
  BuildPassInput,
  PassBarcode,
  PassField,
  PassFile,
  PassImages,
  PassLocationEntry,
  PassSigningMaterial,
  PkpassInput,
  StoreCardFields,
  ZipEntry,
} from "./apple/index.js";
