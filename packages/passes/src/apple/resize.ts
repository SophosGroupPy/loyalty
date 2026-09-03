/**
 * Reducción del logo del comercio a las medidas que pide Apple.
 *
 * **Por qué hace falta.** El `.pkpass` se descarga entero en el teléfono cada
 * vez que cambia el saldo, así que su peso es tráfico recurrente y no un costo
 * de una sola vez. Un logo de 1024×1024 usado tal cual para el ícono de 29
 * puntos deja un pase de 337 KB que se rebaja en cada acumulación: con 500
 * clientes que consumen tres veces por semana, medio giga semanal para un solo
 * comercio.
 *
 * **Por qué se decodifica con una librería y no a mano.** Escribir un PNG de un
 * color sólido es trivial —`png.ts` lo hace— pero leer uno cualquiera no lo es:
 * el logo de un comercio puede venir en paleta, en escala de grises, a 16 bits
 * por canal, con alfa o entrelazado. Un decodificador propio que solo entienda
 * RGB de 8 bits fallaría con la mayoría de los logos reales, y el síntoma sería
 * una tarjeta sin logo sin ninguna explicación.
 *
 * **Solo se achica, nunca se agranda.** Un logo chico estirado se ve peor que
 * uno chico; si el comercio subió algo de 20 px, el problema es el archivo y hay
 * que decírselo, no disimularlo con interpolación.
 */

import { PNG } from "pngjs";

/**
 * Medidas de Apple, en píxeles.
 *
 * `icon` es la que aparece en las notificaciones y en la pantalla bloqueada;
 * `logo` es la de la cara de la tarjeta. Se generan a @2x porque es la densidad
 * mínima de cualquier iPhone en circulación, y una sola imagen por archivo
 * alcanza: iOS reduce si hace falta, pero no inventa detalle si falta.
 */
export const APPLE_ICON_PX = 58;
export const APPLE_LOGO_PX = 160;

/**
 * Ancho máximo de la banda de imagen de un `storeCard`.
 *
 * Apple la pide de 375x123 puntos; a 2x son 750 de ancho. Más que eso es peso
 * que el teléfono baja en cada cambio de saldo sin ganar nitidez.
 */
export const APPLE_STRIP_PX = 750;

export class ResizeError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "ResizeError";
  }
}

/**
 * Reduce un PNG a un cuadro de `maxPx`, conservando la proporción.
 *
 * Promedia los píxeles de origen que caen en cada píxel de destino en vez de
 * tomar el más cercano. Con reducciones grandes —de 1024 a 58— el vecino más
 * cercano descarta el 99,7% de la imagen y produce bordes dentados y colores
 * que no estaban; promediar da lo que uno espera ver.
 */
export function shrinkPng(input: Buffer, maxPx: number): Buffer {
  // Sin esto, un `maxPx` que no sea un número —el caso real fue una constante
  // mal re-exportada, que llegaba `undefined`— propaga NaN por toda la cuenta
  // de escala y **devuelve un PNG corrupto de 65 bytes sin tirar ningún error**.
  // Ese PNG se mete en el .pkpass y iOS rechaza el pase entero sin decir por
  // qué. Fallar acá convierte un bug invisible en uno que se ve en el primer test.
  if (!Number.isFinite(maxPx) || maxPx <= 0) {
    throw new ResizeError(`maxPx tiene que ser un número positivo, llegó ${String(maxPx)}.`);
  }

  let src: PNG;
  try {
    src = PNG.sync.read(input);
  } catch (error) {
    throw new ResizeError("No se pudo leer el PNG.", error);
  }

  const escala = Math.min(1, maxPx / Math.max(src.width, src.height));
  if (escala >= 1) return input;

  const ancho = Math.max(1, Math.round(src.width * escala));
  const alto = Math.max(1, Math.round(src.height * escala));
  const out = new PNG({ width: ancho, height: alto });

  const porX = src.width / ancho;
  const porY = src.height / alto;

  for (let y = 0; y < alto; y++) {
    const desdeY = Math.floor(y * porY);
    const hastaY = Math.max(desdeY + 1, Math.floor((y + 1) * porY));

    for (let x = 0; x < ancho; x++) {
      const desdeX = Math.floor(x * porX);
      const hastaX = Math.max(desdeX + 1, Math.floor((x + 1) * porX));

      let r = 0, g = 0, b = 0, a = 0, n = 0;

      for (let sy = desdeY; sy < hastaY && sy < src.height; sy++) {
        for (let sx = desdeX; sx < hastaX && sx < src.width; sx++) {
          const i = (src.width * sy + sx) << 2;
          // El color se pondera por el alfa: promediar el color de un píxel
          // transparente junto a uno opaco arrastra el borde hacia un color que
          // no está en la imagen, y en un logo sobre fondo transparente eso se
          // ve como un halo.
          const alfa = src.data[i + 3]!;
          r += src.data[i]! * alfa;
          g += src.data[i + 1]! * alfa;
          b += src.data[i + 2]! * alfa;
          a += alfa;
          n += 1;
        }
      }

      const j = (ancho * y + x) << 2;
      const alfaMedio = n > 0 ? a / n : 0;

      if (a > 0) {
        out.data[j] = Math.round(r / a);
        out.data[j + 1] = Math.round(g / a);
        out.data[j + 2] = Math.round(b / a);
      }
      out.data[j + 3] = Math.round(alfaMedio);
    }
  }

  return PNG.sync.write(out);
}

export interface AppleImages {
  icon: Buffer;
  logo: Buffer;
}

/**
 * Deja el logo del comercio en las dos medidas que usa el pase.
 *
 * Si el original ya es más chico que el destino se devuelve tal cual, sin
 * recodificar: recomprimir sin necesidad solo puede empeorarlo.
 */
export function appleImagesFrom(logo: Buffer): AppleImages {
  return {
    icon: shrinkPng(logo, APPLE_ICON_PX),
    logo: shrinkPng(logo, APPLE_LOGO_PX),
  };
}
