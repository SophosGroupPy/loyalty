/**
 * El canal de wallet: entrega a las dos plataformas que la tarjeta tenga.
 *
 * Lo que se prueba acá es el ruteo, no el transporte: que un aviso llegue por
 * Apple aunque no haya pase de Google, que alcance con que UNA entregue, y que
 * "ninguna wallet tiene el pase" sea un caso distinto de "el envío falló" —
 * porque el comercio lee cosas muy distintas de cada uno.
 */

import { describe, expect, it } from "vitest";

import type { PassService } from "../passes.js";
import { NoInstalledPassError, type RenderedNotification } from "./dispatcher.js";
import { createWalletSender, type AppleMessageDeliverer } from "./senders.js";

const aviso: RenderedNotification = {
  id: "n1",
  membershipId: "m1",
  merchantId: "c1",
  channel: "wallet",
  kind: "campaign",
  header: "Miércoles de 2x1",
  body: "Traé un amigo",
  allowGoogle: true,
};

/** Un `PassService` de mentira que solo responde a `sendMessage`. */
function fakePasses(google: () => Promise<"sent" | "no_pass">): PassService {
  return { enabled: true, sendMessage: () => google() } as unknown as PassService;
}

describe("sender de wallet", () => {
  it("entrega por Apple aunque la tarjeta no tenga pase de Google", async () => {
    const recibido: string[] = [];
    const apple: AppleMessageDeliverer = {
      async deliver(_membershipId, body) {
        recibido.push(body);
        return "sent";
      },
    };

    const sender = createWalletSender(fakePasses(async () => "no_pass"), apple);
    await expect(sender.send(aviso)).resolves.toEqual({ apple: true, google: false });
    // El título va adelante para no perder el gancho: en Apple el cliente ve el
    // valor del campo, no un título y un cuerpo aparte como en Google.
    expect(recibido).toEqual(["Miércoles de 2x1: Traé un amigo"]);
  });

  it("entrega por Google aunque no haya canal de Apple configurado", async () => {
    let mandado = false;
    const sender = createWalletSender(
      fakePasses(async () => {
        mandado = true;
        return "sent";
      }),
    );
    await expect(sender.send(aviso)).resolves.toEqual({ apple: false, google: true });
    expect(mandado).toBe(true);
  });

  it("sin cupo de Google no toca Google, pero entrega igual por Apple", async () => {
    // El caso que rompía en producción: el tope de 3/24 h es de Google, y al
    // aplicarlo al aviso entero dejaba mudo a un cliente de iPhone —donde la
    // plataforma no impone ningún tope—. Google se saltea; Apple entrega.
    let tocaronGoogle = false;
    const apple: AppleMessageDeliverer = { async deliver() { return "sent"; } };
    const sender = createWalletSender(
      fakePasses(async () => {
        tocaronGoogle = true;
        return "sent";
      }),
      apple,
    );

    await expect(sender.send({ ...aviso, allowGoogle: false })).resolves.toEqual({
      apple: true,
      google: false,
    });
    expect(tocaronGoogle).toBe(false);
  });

  it("sin cupo de Google y sin pase de Apple, no hay dónde entregar", async () => {
    const apple: AppleMessageDeliverer = { async deliver() { return "no_target"; } };
    const sender = createWalletSender(fakePasses(async () => "sent"), apple);
    await expect(
      sender.send({ ...aviso, allowGoogle: false }),
    ).rejects.toBeInstanceOf(NoInstalledPassError);
  });

  it("si ninguna wallet tiene el pase, es NoInstalledPassError y no un fallo", async () => {
    const apple: AppleMessageDeliverer = { async deliver() { return "no_target"; } };
    const sender = createWalletSender(fakePasses(async () => "no_pass"), apple);
    await expect(sender.send(aviso)).rejects.toBeInstanceOf(NoInstalledPassError);
  });

  it("un fallo real de transporte se propaga como envío fallido", async () => {
    const sender = createWalletSender(
      fakePasses(async () => {
        throw new Error("google caído");
      }),
    );
    // No es NoInstalledPassError: se rompió el transporte, y el despachador tiene
    // que marcarlo como send_failed, no como "sin pase instalado".
    await expect(sender.send(aviso)).rejects.toThrow("google caído");
  });

  it("entrega por Apple aunque el pase de Google esté roto (404)", async () => {
    // El caso real: la tarjeta tiene pase en las dos wallets, el objeto de Google
    // quedó 404, y Apple sí está instalado. El fallo de Google NO puede impedir
    // que Apple entregue.
    const apple: AppleMessageDeliverer = { async deliver() { return "sent"; } };
    const sender = createWalletSender(
      fakePasses(async () => {
        throw new Error("Google 404: Wallet Object not found");
      }),
      apple,
    );
    await expect(sender.send(aviso)).resolves.toEqual({ apple: true, google: false });
  });

  it("si Google falla y Apple no tiene pase, es send_failed (propaga), no NoInstalledPass", async () => {
    const apple: AppleMessageDeliverer = { async deliver() { return "no_target"; } };
    const sender = createWalletSender(
      fakePasses(async () => {
        throw new Error("Google 404");
      }),
      apple,
    );
    // Hubo un destino (Google) y su transporte falló: send_failed, con el error.
    await expect(sender.send(aviso)).rejects.toThrow("Google 404");
  });
});
