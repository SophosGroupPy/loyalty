/**
 * Reducción del logo.
 *
 * Lo que se prueba no es solo que la función corra: es que el pase deje de
 * pesar lo que pesaba. Ese número es el motivo de que este módulo exista.
 */

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { solidPng } from "./png.js";
import { APPLE_ICON_PX, APPLE_LOGO_PX, appleImagesFrom, ResizeError, shrinkPng } from "./resize.js";

/** PNG con dos mitades de distinto color, para ver si promedia bien. */
function mitadYMitad(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (size * y + x) << 2;
      const izquierda = x < size / 2;
      png.data[i] = izquierda ? 255 : 0;
      png.data[i + 1] = 0;
      png.data[i + 2] = izquierda ? 0 : 255;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("achicar", () => {
  it("deja la imagen dentro del cuadro pedido", () => {
    const chico = PNG.sync.read(shrinkPng(solidPng(1024, "#DC2626"), 58));
    expect(chico.width).toBe(58);
    expect(chico.height).toBe(58);
  });

  it("conserva la proporción", () => {
    const ancho = new PNG({ width: 400, height: 100 });
    ancho.data.fill(255);
    const chico = PNG.sync.read(shrinkPng(PNG.sync.write(ancho), 160));

    expect(chico.width).toBe(160);
    expect(chico.height).toBe(40);
  });

  it("no agranda una imagen chica", () => {
    // Estirar un logo de 20 px se ve peor que dejarlo chico. Si el archivo está
    // mal, hay que decírselo al comercio, no disimularlo interpolando.
    const original = solidPng(20, "#DC2626");
    expect(shrinkPng(original, 160)).toBe(original);
  });

  it("conserva el color de un logo de un solo tono", () => {
    const chico = PNG.sync.read(shrinkPng(solidPng(512, "#DC2626"), 58));
    expect([chico.data[0], chico.data[1], chico.data[2]]).toEqual([220, 38, 38]);
  });

  it("promedia en vez de descartar píxeles", () => {
    // Con vecino más cercano, reducir de 512 a 2 tiraría el 99,99% de la
    // imagen. Promediando, cada mitad conserva su color.
    const chico = PNG.sync.read(shrinkPng(mitadYMitad(512), 2));
    expect(chico.data[0]).toBeGreaterThan(200); // izquierda roja
    expect(chico.data[6]).toBeGreaterThan(200); // derecha azul
  });

  it("avisa cuando el archivo no es un PNG legible", () => {
    expect(() => shrinkPng(Buffer.from("no soy un png"), 58)).toThrow(ResizeError);
  });
});

describe("las dos medidas del pase", () => {
  it("genera ícono y logo", () => {
    const { icon, logo } = appleImagesFrom(solidPng(1024, "#DC2626"));
    expect(PNG.sync.read(icon).width).toBe(APPLE_ICON_PX);
    expect(PNG.sync.read(logo).width).toBe(APPLE_LOGO_PX);
  });

  it("achica de verdad el peso, que es el punto", () => {
    // El número concreto: un logo de 1024x1024 dejaba un pase de 337 KB porque
    // el mismo archivo se usaba para el ícono de 29 puntos y para el logo. El
    // pase se rebaja entero en cada cambio de saldo.
    const original = solidPng(1024, "#DC2626");
    const { icon, logo } = appleImagesFrom(original);

    const antes = original.length * 2;
    const despues = icon.length + logo.length;

    expect(despues).toBeLessThan(antes / 10);
  });
});
