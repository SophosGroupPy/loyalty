/**
 * Canales de envío.
 *
 * El despachador decide **si** se manda; estos objetos saben **cómo**. Separarlo
 * permite sumar WhatsApp o web push sin tocar la lógica de cupo y prioridad.
 */

import type { PassService } from "../passes.js";
import type { NotificationSender, RenderedNotification } from "./dispatcher.js";

/**
 * Wallet. Manda el aviso como mensaje del pase.
 *
 * Se usa `addMessage` y no el disparo por cambio de saldo porque sirve para
 * cualquier tipo de aviso —campañas, niveles, beneficios— y porque no depende de
 * `notifyPreference`, cuyo valor la documentación de Google define de dos formas
 * distintas. Ver docs/google-wallet-verificacion.md.
 */
export function createWalletSender(passes: PassService): NotificationSender {
  return {
    async send(notification: RenderedNotification) {
      await passes.sendMessage(notification.membershipId, {
        // El id del aviso alcanza como id de mensaje: es único y permite rastrear
        // en la tarjeta cuál de los envíos registrados lo produjo.
        id: notification.id,
        header: notification.header,
        body: notification.body,
      });
    },
  };
}

/**
 * Sender de desarrollo: imprime en consola en vez de mandar.
 *
 * Sirve para probar el despachador completo sin credenciales de ninguna
 * plataforma, que es la situación hasta que exista el Issuer.
 */
export function createConsoleSender(
  log: (message: string) => void = console.log,
): NotificationSender {
  return {
    async send(notification: RenderedNotification) {
      log(
        `[notificación:${notification.channel}] ${notification.kind} → ` +
          `${notification.header}: ${notification.body}`,
      );
    },
  };
}

/** Reparte cada aviso al canal que corresponde. */
export function createRoutingSender(
  senders: Partial<Record<RenderedNotification["channel"], NotificationSender>>,
  fallback?: NotificationSender,
): NotificationSender {
  return {
    async send(notification: RenderedNotification) {
      const sender = senders[notification.channel] ?? fallback;
      if (!sender) {
        throw new Error(`Sin canal configurado para "${notification.channel}".`);
      }
      await sender.send(notification);
    },
  };
}
