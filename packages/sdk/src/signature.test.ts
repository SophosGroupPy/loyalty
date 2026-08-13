/**
 * Firma de webhooks.
 *
 * Es el único punto donde el producto puede confiar en que un pedido salió de
 * Sophos. Si la verificación acepta algo que no debería, cualquiera que conozca
 * la URL puede inventar canjes y saldos.
 */

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { signPayload, verifySignature } from "./signature.js";

const SECRET = "un-secreto-de-prueba-suficientemente-largo";
const BODY = JSON.stringify({ eventId: "e1", type: "reward.available", data: { balance: 40 } });
const NOW = 1_786_636_000;

describe("firma y verificación", () => {
  it("acepta una entrega legítima", () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW })).toEqual({ valid: true });
  });

  it("rechaza si cambia un solo carácter del cuerpo", () => {
    const header = signPayload(BODY, SECRET, NOW);
    const alterado = BODY.replace('"balance":40', '"balance":4000');

    expect(verifySignature(alterado, header, SECRET, { nowSeconds: NOW })).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  it("rechaza con el secreto equivocado", () => {
    const header = signPayload(BODY, SECRET, NOW);
    expect(verifySignature(BODY, header, "otro-secreto", { nowSeconds: NOW }).valid).toBe(false);
  });

  it("rechaza una entrega vieja aunque la firma sea válida", () => {
    // Sin esto, alguien que capture una entrega puede reenviarla mañana y
    // duplicar el canje que anunciaba.
    const header = signPayload(BODY, SECRET, NOW);

    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW + 3600 })).toEqual({
      valid: false,
      reason: "expired",
    });
  });

  it("rechaza una entrega del futuro", () => {
    const header = signPayload(BODY, SECRET, NOW + 3600);
    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW }).valid).toBe(false);
  });

  it("no se deja engañar cambiando el timestamp de la cabecera", () => {
    // El timestamp va dentro de lo firmado, así que moverlo para esquivar el
    // vencimiento invalida la firma en vez de renovarla.
    const header = signPayload(BODY, SECRET, NOW);
    const movido = header.replace(`t=${NOW}`, `t=${NOW + 7200}`);

    expect(verifySignature(BODY, movido, SECRET, { nowSeconds: NOW + 7200 })).toEqual({
      valid: false,
      reason: "mismatch",
    });
  });

  it("rechaza cabeceras mal formadas o ausentes", () => {
    for (const header of [undefined, "", "basura", `v1=${"a".repeat(64)}`, `t=${NOW}`]) {
      expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW }).valid).toBe(false);
    }
  });

  it("interopera con una implementación externa del mismo algoritmo", () => {
    // Reproduce lo que haría un integrador siguiendo la documentación, sin usar
    // nuestro código: si esto falla, el contrato publicado no coincide.
    const propia = createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");

    expect(signPayload(BODY, SECRET, NOW)).toBe(`t=${NOW},v1=${propia}`);
    expect(
      verifySignature(BODY, `t=${NOW},v1=${propia}`, SECRET, { nowSeconds: NOW }),
    ).toEqual({ valid: true });
  });

  it("tolera un desfasaje de reloj razonable", () => {
    const header = signPayload(BODY, SECRET, NOW);
    // Cuatro minutos de diferencia: dentro de la ventana de cinco.
    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW + 240 }).valid).toBe(true);
  });
});
