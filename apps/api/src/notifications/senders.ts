/**
 * Canales de envío.
 *
 * El despachador decide **si** se manda; estos objetos saben **cómo**. Separarlo
 * permite sumar WhatsApp o web push sin tocar la lógica de cupo y prioridad.
 */

import type { PassService } from "../passes.js";
import {
  NoInstalledPassError,
  type NotificationSender,
  type RenderedNotification,
} from "./dispatcher.js";

/**
 * Entrega un aviso a la tarjeta de Apple. La implementa `apns.ts`; se recibe como
 * dependencia para que este módulo no dependa de la capa de push.
 */
export interface AppleMessageDeliverer {
  /** `"no_target"` si la tarjeta no tiene pase de Apple instalado. */
  deliver(membershipId: string, body: string): Promise<"sent" | "no_target">;
}

/**
 * Wallet. Entrega el aviso a las dos plataformas que la tarjeta tenga.
 *
 * Cada wallet tiene su vía: Google recibe `addMessage`; Apple no recibe texto, así
 * que el aviso viaja como el valor nuevo del campo de novedades del pase (con
 * `changeMessage`) más un push que hace al teléfono volver a pedirlo. Una tarjeta
 * puede estar en una wallet, en la otra o en las dos, así que se intenta cada una
 * y alcanza con que **una** entregue. Si ninguna tiene pase instalado, se lanza
 * `NoInstalledPassError`: no es un fallo de envío, es que no hay destino.
 */
export function createWalletSender(
  passes: PassService,
  apple?: AppleMessageDeliverer,
): NotificationSender {
  return {
    async send(notification: RenderedNotification) {
      let entregado = false;
      // Un fallo REAL de transporte en una wallet no puede tumbar a la otra. Pasa
      // seguido: una tarjeta tiene pase en las dos, el objeto de Google quedó 404
      // (nunca se guardó de verdad) y Apple sí está instalado. Si el error de
      // Google cortara acá, Apple —que sí podía entregar— nunca se intentaría. Se
      // guarda el último error y solo se propaga si NINGUNA wallet entregó.
      let fallo: unknown = null;

      // Google: `addMessage` si la tarjeta tiene pase de Google. Devuelve
      // `"no_pass"` sin tirar cuando no lo tiene; tira ante un fallo real de
      // transporte.
      try {
        const google = await passes.sendMessage(notification.membershipId, {
          // El id del aviso alcanza como id de mensaje: es único y permite
          // rastrear en la tarjeta cuál de los envíos registrados lo produjo.
          id: notification.id,
          header: notification.header,
          body: notification.body,
        });
        if (google === "sent") entregado = true;
      } catch (error) {
        fallo = error;
      }

      // Apple: el aviso es el valor del campo de novedades. En la pantalla el
      // cliente ve ese valor, así que se antepone el título para no perder el
      // gancho ("Miércoles de 2x1: Traé un amigo…"). Se intenta SIEMPRE, aunque
      // Google haya fallado.
      if (apple) {
        try {
          const texto = notification.header
            ? `${notification.header}: ${notification.body}`
            : notification.body;
          const resultado = await apple.deliver(notification.membershipId, texto);
          if (resultado === "sent") entregado = true;
        } catch (error) {
          fallo = error;
        }
      }

      if (entregado) return;
      // Hubo un destino pero el transporte falló: es un envío fallido de verdad,
      // no un "sin pase instalado".
      if (fallo) throw fallo;
      // Ninguna wallet tenía pase: no hay dónde entregar.
      throw new NoInstalledPassError();
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
