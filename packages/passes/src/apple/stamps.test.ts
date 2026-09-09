/**
 * La banda de sellos.
 *
 * Se verifica leyendo el PNG que sale, no comparándolo contra una imagen de
 * referencia: un test de píxeles exactos se rompe con cualquier ajuste de
 * diseño y no dice nada de si la banda se ve bien. Lo que sí importa y sí se
 * puede afirmar es que el PNG sea válido, mida lo que Apple espera, y que un
 * sello lleno se distinga de uno vacío por algo más que el color.
 */

import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { esOscuro, stampStrip, STRIP_HEIGHT, STRIP_WIDTH } from "./stamps.js";

const leer = (buf: Buffer) => PNG.sync.read(buf);

/** Color del píxel central del sello `i` de `total`, en una sola fila. */
function pixelDelSello(png: PNG, i: number, total: number) {
  const pad = 44;
  const celda = (STRIP_WIDTH - pad * 2) / total;
  const x = Math.round(pad + celda * (i + 0.5));
  const y = Math.round(STRIP_HEIGHT / 2);
  const idx = (y * png.width + x) * 4;
  return { r: png.data[idx]!, g: png.data[idx + 1]!, b: png.data[idx + 2]! };
}

describe("banda de sellos", () => {
  it("sale un PNG con las medidas que pide Apple", () => {
    const png = leer(stampStrip({ total: 6, earned: 2, backgroundColor: "#00A63E" }));
    expect(png.width).toBe(STRIP_WIDTH);
    expect(png.height).toBe(STRIP_HEIGHT);
  });

  it("el sello lleno y el vacío no son el mismo píxel", () => {
    // Si fueran iguales, la tarjeta no comunicaría nada.
    const png = leer(
      stampStrip({ total: 4, earned: 2, backgroundColor: "#00A63E", accentColor: "#FFFFFF" }),
    );
    const lleno = pixelDelSello(png, 0, 4);
    const vacio = pixelDelSello(png, 3, 4);
    expect(lleno).not.toEqual(vacio);
  });

  it("el sello lleno lleva el color de acento", () => {
    const png = leer(
      stampStrip({ total: 3, earned: 3, backgroundColor: "#1C1917", accentColor: "#CA8A04" }),
    );
    const { r, g, b } = pixelDelSello(png, 1, 3);
    // El centro del disco puede caer sobre el tilde, así que se compara la
    // dominante del canal y no el valor exacto.
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
  });

  it("cambiar el saldo cambia la imagen", () => {
    // Es lo que hace que la tarjeta se sienta viva: si dos saldos distintos
    // dieran la misma banda, el pase se vería congelado.
    const dos = stampStrip({ total: 6, earned: 2, backgroundColor: "#00A63E" });
    const tres = stampStrip({ total: 6, earned: 3, backgroundColor: "#00A63E" });
    expect(dos.equals(tres)).toBe(false);
  });

  it("no se pasa del total ni baja de cero", () => {
    const dePlus = stampStrip({ total: 5, earned: 99, backgroundColor: "#00A63E" });
    const deMenos = stampStrip({ total: 5, earned: -3, backgroundColor: "#00A63E" });
    const completo = stampStrip({ total: 5, earned: 5, backgroundColor: "#00A63E" });
    const vacio = stampStrip({ total: 5, earned: 0, backgroundColor: "#00A63E" });

    expect(dePlus.equals(completo)).toBe(true);
    expect(deMenos.equals(vacio)).toBe(true);
  });

  it("aguanta un total absurdo sin tirar", () => {
    // El comercio escribe el número a mano en la consola.
    expect(() => stampStrip({ total: 500, earned: 3, backgroundColor: "#00A63E" })).not.toThrow();
    expect(() => stampStrip({ total: 0, earned: 0, backgroundColor: "#00A63E" })).not.toThrow();
  });

  it("una foto ilegible no rompe la banda", () => {
    // Una banda que no se puede dibujar no es motivo para dejar a alguien sin
    // tarjeta: se cae al color de marca.
    const conBasura = stampStrip({
      total: 4,
      earned: 1,
      background: Buffer.from("esto no es un png"),
      backgroundColor: "#00A63E",
    });
    expect(leer(conBasura).width).toBe(STRIP_WIDTH);
  });

  it("usa la foto cuando se puede leer", () => {
    const foto = new PNG({ width: 800, height: 300 });
    for (let i = 0; i < foto.data.length; i += 4) {
      foto.data[i] = 200;
      foto.data[i + 1] = 30;
      foto.data[i + 2] = 30;
      foto.data[i + 3] = 255;
    }
    const conFoto = stampStrip({
      total: 4,
      earned: 1,
      background: PNG.sync.write(foto),
      backgroundColor: "#00A63E",
    });
    const sinFoto = stampStrip({ total: 4, earned: 1, backgroundColor: "#00A63E" });
    expect(conFoto.equals(sinFoto)).toBe(false);

    // La esquina no tiene sellos encima: ahí se ve el fondo con el velo.
    const png = leer(conFoto);
    expect(png.data[0]!).toBeGreaterThan(png.data[1]!);
  });

  it("más de seis sellos se acomodan en dos filas", () => {
    // En una sola fila, diez sellos quedan tan chicos que no se leen.
    const png = leer(stampStrip({ total: 10, earned: 10, backgroundColor: "#1C1917", accentColor: "#CA8A04" }));

    // La franja central queda libre entre las dos filas.
    const medio = (Math.round(STRIP_HEIGHT / 2) * png.width + 60) * 4;
    expect(png.data[medio]).toBeLessThan(60);
  });
});

describe("luminancia", () => {
  it("distingue claro de oscuro", () => {
    expect(esOscuro("#000000")).toBe(true);
    expect(esOscuro("#FFFFFF")).toBe(false);
    expect(esOscuro("#1C1917")).toBe(true);
    expect(esOscuro("#F5F1E8")).toBe(false);
  });

  it("pesa el verde más que el azul", () => {
    // Promediar los canales daría lo mismo para estos dos, y es justo el error
    // que deja los verdes saturados con texto ilegible.
    expect(esOscuro("#0000FF")).toBe(true);
    expect(esOscuro("#00FF00")).toBe(false);
  });
});

describe("icono personalizado del sello", () => {
  /** Un icono con alfa: un cuadrado central opaco sobre transparente. */
  function iconoCuadrado(): Buffer {
    const S = 80;
    const p = new PNG({ width: S, height: S });
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const dentro = x > 24 && x < 56 && y > 24 && y < 56;
        p.data[i] = 20;
        p.data[i + 1] = 20;
        p.data[i + 2] = 20;
        p.data[i + 3] = dentro ? 255 : 0;
      }
    }
    return PNG.sync.write(p);
  }

  it("con icono, la banda cambia respecto de la del tilde", () => {
    const base = { total: 6, earned: 3, backgroundColor: "#00A63E", accentColor: "#FFFFFF" as string };
    const conTilde = stampStrip(base);
    const conIcono = stampStrip({ ...base, icon: iconoCuadrado() });
    expect(conTilde.equals(conIcono)).toBe(false);
  });

  it("un icono ilegible no rompe la banda: cae al tilde", () => {
    const base = { total: 6, earned: 3, backgroundColor: "#00A63E" };
    const conBasura = stampStrip({ ...base, icon: Buffer.from("no soy un png") });
    // Sale una banda válida igual (no tira, no queda vacía).
    expect(leer(conBasura).width).toBe(STRIP_WIDTH);
    // Y es idéntica a la del tilde: el icono roto simplemente se ignora.
    expect(conBasura.equals(stampStrip(base))).toBe(true);
  });

  it("el icono se dibuja sólido en el lleno y tenue en el vacío", () => {
    // Un solo sello lleno + un solo vacío, para comparar el centro de cada uno.
    const png = leer(
      stampStrip({ total: 2, earned: 1, backgroundColor: "#1C1917", accentColor: "#FFFFFF", icon: iconoCuadrado() }),
    );
    // El icono es oscuro sobre disco claro en el lleno, y tenue en el vacío;
    // basta con que los dos centros difieran (el dibujo cambió algo en cada uno).
    const lleno = pixelDelSello(png, 0, 2);
    const vacio = pixelDelSello(png, 1, 2);
    expect(lleno).not.toEqual(vacio);
  });
});
