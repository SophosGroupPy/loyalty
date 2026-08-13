/**
 * Literales de la API de Google Wallet, todos juntos a propósito.
 *
 * La documentación de Google se contradice a sí misma en varios de estos
 * valores: la referencia REST usa una forma y las páginas de casos de uso otra.
 * Sin un Issuer real no se puede dirimir, y equivocarse no da error — la
 * notificación simplemente no se dispara, que es la peor forma de fallar.
 *
 * Por eso están centralizados: cuando exista el Issuer, se prueba contra la API
 * real y se corrige **solo acá**.
 *
 * @see docs/google-wallet-verificacion.md
 */

/**
 * Estado de revisión de una clase.
 *
 * La referencia lista `draft | underReview | approved`; la forma canónica de los
 * enums de Google es UPPER_SNAKE. `UNDER_REVIEW` es lo que corresponde para una
 * clase creada por API: una clase en `draft` no puede tener objetos.
 *
 * ⚠️ VERIFICAR contra la API real.
 */
export const REVIEW_STATUS_UNDER_REVIEW = "UNDER_REVIEW";

/** Estado de un objeto: la tarjeta está vigente. */
export const STATE_ACTIVE = "ACTIVE";
/** La tarjeta se movió a "pases vencidos" del usuario. */
export const STATE_INACTIVE = "INACTIVE";

/**
 * Pide a Google que dispare notificación al cambiar campos que notifican.
 *
 * **Verificado contra la API real el 2026-08-12.** La documentación de Google se
 * contradecía: la referencia REST de `loyaltyclass` decía *"When set to NOTIFY,
 * we will attempt to trigger a field update notification"*, y las páginas de
 * casos de uso decían `notifyOnUpdate`.
 *
 * **Ganan las páginas de casos de uso.** La API rechaza `"NOTIFY"` con:
 *
 *     Invalid value at 'resource.notify_preference'
 *     (…v1.NotificationSettingsForUpdates), "NOTIFY"
 *
 * Es **transient**: hay que mandarlo en cada request que deba notificar, no se
 * configura una sola vez.
 */
export const NOTIFY_PREFERENCE_ON_UPDATE = "NOTIFY_ON_UPDATE";

/**
 * Agrega el mensaje al dorso del pase Y dispara una notificación push.
 * `TEXT` solo lo agrega sin notificar.
 */
export const MESSAGE_TYPE_TEXT_AND_NOTIFY = "TEXT_AND_NOTIFY";
export const MESSAGE_TYPE_TEXT = "TEXT";

export const BARCODE_TYPE_QR = "QR_CODE";

/** Scope OAuth2 necesario para emitir y actualizar pases. */
export const WALLET_SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";

export const WALLET_API_BASE = "https://walletobjects.googleapis.com/walletobjects/v1";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SAVE_LINK_BASE = "https://pay.google.com/gp/v/save/";

/**
 * Tope de notificaciones que Google acepta por pase cada 24 horas.
 *
 * Se replica del lado de Sophos en vez de confiar en el rechazo de Google:
 * el Issuer es único para todo el ecosistema, así que si un comercio abusa, el
 * throttling cae sobre **todos** los comercios a la vez.
 */
export const NOTIFICATIONS_PER_PASS_PER_DAY = 3;
