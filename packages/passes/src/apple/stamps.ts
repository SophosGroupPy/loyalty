/**
 * Banda de sellos, dibujada por tarjeta.
 *
 * Un programa de sellos mostrado como el número "3" no se siente como una
 * tarjeta de sellos: se siente como un contador. Lo que la vuelve reconocible es
 * ver los casilleros —los llenos y los que faltan— de un vistazo, sin leer.
 *
 * Apple no deja dibujar nada: el pase tiene ranuras fijas y una sola imagen
 * ancha, la banda. Así que los sellos **se rinden dentro de esa imagen**, y hay
 * que generarla de nuevo cada vez que el saldo cambia. Es la única forma de
 * tener sellos de verdad en una wallet, y es también por qué no se puede hacer
 * con una imagen que sube el comercio.
 *
 * Se dibuja a mano sobre el búfer RGBA en vez de traer una librería de canvas:
 * son círculos, anillos y dos segmentos de línea. Una dependencia nativa para
 * esto costaría más en instalación y superficie que lo que ahorra.
 */

import { PNG } from "pngjs";

/** Medidas de la banda de Apple en @2x, que es lo que se manda. */
export const STRIP_WIDTH = 750;
export const STRIP_HEIGHT = 246;

/** Más allá de esto los sellos quedan demasiado chicos para leerse. */
export const MAX_STAMPS_DRAWN = 12;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string, fallback: Rgb): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[1]!, 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/**
 * ¿Este color es oscuro?
 *
 * Decide si los sellos vacíos se dibujan en blanco o en negro. Con luminancia
 * relativa y no con el promedio de los canales: el ojo pesa el verde mucho más
 * que el azul, y promediar da mal justo en los verdes y azules saturados que
 * usan los comercios.
 */
export function esOscuro(hex: string): boolean {
  const { r, g, b } = parseHex(hex, { r: 0, g: 0, b: 0 });
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.55;
}

/** Mezcla `color` sobre lo que ya hay, con opacidad `alpha` (0..1). */
function blend(png: PNG, x: number, y: number, color: Rgb, alpha: number): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  if (alpha <= 0) return;

  const i = (y * png.width + x) * 4;
  const a = Math.min(1, alpha);
  png.data[i] = Math.round(png.data[i]! * (1 - a) + color.r * a);
  png.data[i + 1] = Math.round(png.data[i + 1]! * (1 - a) + color.g * a);
  png.data[i + 2] = Math.round(png.data[i + 2]! * (1 - a) + color.b * a);
  png.data[i + 3] = 255;
}

/**
 * Disco relleno con borde suavizado.
 *
 * El antialias no es un lujo: un círculo de 50 px sin suavizar se ve como un
 * polígono, y en una tarjeta que la persona mira de cerca eso lee como algo mal
 * hecho. Se resuelve con la distancia al centro en vez de con muestreo — un
 * píxel a menos de `r - 1` va lleno, y el anillo de un píxel se atenúa.
 */
function disco(png: PNG, cx: number, cy: number, r: number, color: Rgb, alpha = 1): void {
  const desde = Math.floor(cx - r - 1);
  const hasta = Math.ceil(cx + r + 1);
  const arriba = Math.floor(cy - r - 1);
  const abajo = Math.ceil(cy + r + 1);

  for (let y = arriba; y <= abajo; y++) {
    for (let x = desde; x <= hasta; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r - 1) blend(png, x, y, color, alpha);
      else if (d < r + 1) blend(png, x, y, color, alpha * (1 - (d - (r - 1)) / 2));
    }
  }
}

/** Anillo del mismo grosor en todo el contorno. */
function anillo(
  png: PNG,
  cx: number,
  cy: number,
  r: number,
  grosor: number,
  color: Rgb,
  alpha = 1,
): void {
  const externo = r + grosor / 2;
  const interno = r - grosor / 2;

  for (let y = Math.floor(cy - externo - 1); y <= Math.ceil(cy + externo + 1); y++) {
    for (let x = Math.floor(cx - externo - 1); x <= Math.ceil(cx + externo + 1); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d >= interno && d <= externo) blend(png, x, y, color, alpha);
      else if (d > externo && d < externo + 1) {
        blend(png, x, y, color, alpha * (1 - (d - externo)));
      } else if (d < interno && d > interno - 1) {
        blend(png, x, y, color, alpha * (1 - (interno - d)));
      }
    }
  }
}

/** Segmento con extremos redondeados, dibujando discos a lo largo. */
function linea(
  png: PNG,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  grosor: number,
  color: Rgb,
): void {
  const pasos = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
  for (let i = 0; i <= pasos; i++) {
    const t = i / pasos;
    disco(png, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, grosor / 2, color);
  }
}

/**
 * El tilde del sello completado.
 *
 * No es decoración. Si lo lleno y lo vacío se distinguieran solo por color, la
 * tarjeta sería ilegible para quien no distingue esos dos colores — y también
 * para cualquiera que la mire de reojo sobre una foto con mucho contraste. La
 * forma hace el trabajo y el color acompaña.
 */
function tilde(png: PNG, cx: number, cy: number, r: number, color: Rgb): void {
  const g = Math.max(3, r * 0.22);
  linea(png, cx - r * 0.42, cy + r * 0.04, cx - r * 0.1, cy + r * 0.36, g, color);
  linea(png, cx - r * 0.1, cy + r * 0.36, cx + r * 0.44, cy - r * 0.34, g, color);
}

export interface StampStripInput {
  /** Cuántos sellos pide el premio. */
  total: number;
  /** Cuántos tiene la persona ahora. */
  earned: number;
  /**
   * Foto del comercio, PNG de 750 px de ancho. Si no viene, la banda queda del
   * color de marca — que se ve bastante mejor que la nada que había antes.
   */
  background?: Buffer | null;
  /** Color de fondo de la tarjeta, en hex. */
  backgroundColor: string;
  /** Color de los sellos completados, en hex. */
  accentColor?: string;
  /**
   * Icono del sello, PNG con transparencia. Si viene, reemplaza al tilde: el
   * sello lleno lo muestra sólido y el vacío lo muestra tenue, así el cliente ve
   * de una qué está juntando (un café, una hamburguesa) en vez de un tilde
   * genérico. Se usa solo su forma (el canal alfa); el color lo pone la tarjeta.
   */
  icon?: Buffer | null;
}

/**
 * Recorta y centra la foto para llenar la banda, al estilo `object-fit: cover`.
 *
 * Deformarla para que entre sería peor que recortarla: una foto de comida
 * estirada se nota inmediatamente y es justo lo que se quería evitar.
 */
function fondoDesde(foto: PNG, destino: PNG): void {
  const escala = Math.max(STRIP_WIDTH / foto.width, STRIP_HEIGHT / foto.height);
  const offsetX = (foto.width * escala - STRIP_WIDTH) / 2;
  const offsetY = (foto.height * escala - STRIP_HEIGHT) / 2;

  for (let y = 0; y < STRIP_HEIGHT; y++) {
    for (let x = 0; x < STRIP_WIDTH; x++) {
      const sx = Math.min(foto.width - 1, Math.max(0, Math.floor((x + offsetX) / escala)));
      const sy = Math.min(foto.height - 1, Math.max(0, Math.floor((y + offsetY) / escala)));
      const src = (sy * foto.width + sx) * 4;
      const dst = (y * STRIP_WIDTH + x) * 4;
      destino.data[dst] = foto.data[src]!;
      destino.data[dst + 1] = foto.data[src + 1]!;
      destino.data[dst + 2] = foto.data[src + 2]!;
      destino.data[dst + 3] = 255;
    }
  }
}

/**
 * Estampa la forma de un icono, recoloreada, centrada en (cx, cy).
 *
 * Usa **solo el canal alfa** del icono: su color propio se descarta y se pinta
 * con `color`. Así un icono en cualquier color sirve, y la tarjeta manda el
 * contraste. Se escala con `object-fit: contain` para que no se deforme, y a
 * `frac` del diámetro del sello para dejarle aire al borde.
 */
function dibujarIcono(
  png: PNG,
  icono: PNG,
  cx: number,
  cy: number,
  diametro: number,
  color: Rgb,
  alpha: number,
): void {
  const lado = diametro * 0.62;
  const escala = lado / Math.max(icono.width, icono.height);
  const w = icono.width * escala;
  const h = icono.height * escala;
  const x0 = cx - w / 2;
  const y0 = cy - h / 2;

  for (let y = 0; y < Math.ceil(h); y++) {
    for (let x = 0; x < Math.ceil(w); x++) {
      const sx = Math.min(icono.width - 1, Math.floor(x / escala));
      const sy = Math.min(icono.height - 1, Math.floor(y / escala));
      const a = icono.data[(sy * icono.width + sx) * 4 + 3]! / 255;
      if (a > 0.02) blend(png, Math.round(x0 + x), Math.round(y0 + y), color, a * alpha);
    }
  }
}

/**
 * Dibuja la banda con los sellos.
 *
 * Nunca tira: una banda que no se puede dibujar no es motivo para dejar a la
 * persona sin tarjeta. Ante cualquier problema con la foto se sigue con el color
 * de marca.
 */
export function stampStrip(input: StampStripInput): Buffer {
  const png = new PNG({ width: STRIP_WIDTH, height: STRIP_HEIGHT });
  const fondo = parseHex(input.backgroundColor, { r: 17, g: 17, b: 17 });

  let conFoto = false;
  if (input.background) {
    try {
      fondoDesde(PNG.sync.read(input.background), png);
      conFoto = true;
    } catch {
      conFoto = false;
    }
  }

  if (!conFoto) {
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = fondo.r;
      png.data[i + 1] = fondo.g;
      png.data[i + 2] = fondo.b;
      png.data[i + 3] = 255;
    }
  } else {
    // Velo oscuro sobre la foto. Sin esto, los sellos se pierden contra las
    // zonas claras de cualquier foto de comida y la banda queda ilegible justo
    // en el dato que importa.
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = Math.round(png.data[i]! * 0.62);
      png.data[i + 1] = Math.round(png.data[i + 1]! * 0.62);
      png.data[i + 2] = Math.round(png.data[i + 2]! * 0.62);
    }
  }

  const total = Math.max(1, Math.min(MAX_STAMPS_DRAWN, Math.floor(input.total)));
  const llenos = Math.max(0, Math.min(total, Math.floor(input.earned)));

  // Icono del comercio, si lo subió. Si no se puede leer, se cae al tilde: un
  // sello con tilde es mejor que ninguno.
  let icono: PNG | null = null;
  if (input.icon) {
    try {
      icono = PNG.sync.read(input.icon);
    } catch {
      icono = null;
    }
  }

  // Sobre foto con velo, blanco siempre gana. Sobre color plano depende del
  // color que eligió el comercio.
  const claro = { r: 255, g: 255, b: 255 };
  const tinta = conFoto || esOscuro(input.backgroundColor) ? claro : { r: 17, g: 17, b: 17 };
  const acento = input.accentColor ? parseHex(input.accentColor, claro) : claro;
  // El tilde va del color del fondo del disco, así que tiene que contrastar con
  // el acento y no con la banda.
  const tintaTilde = esOscuro(input.accentColor ?? "#ffffff")
    ? claro
    : { r: 17, g: 17, b: 17 };

  const filas = total > 6 ? 2 : 1;
  const porFila = Math.ceil(total / filas);
  const pad = 44;
  const celda = (STRIP_WIDTH - pad * 2) / porFila;
  const radio = Math.min(celda * 0.33, filas === 1 ? 46 : 34);
  const separacionY = radio + 12;

  for (let i = 0; i < total; i++) {
    const fila = Math.floor(i / porFila);
    const col = i % porFila;
    // La última fila incompleta se centra: dejarla pegada a la izquierda se ve
    // como un error de maquetado.
    const enEstaFila = Math.min(porFila, total - fila * porFila);
    const sobra = (porFila - enEstaFila) * celda;

    const cx = pad + sobra / 2 + celda * (col + 0.5);
    const cy =
      filas === 1
        ? STRIP_HEIGHT / 2
        : STRIP_HEIGHT / 2 + (fila === 0 ? -separacionY : separacionY);

    // Sombra suave detrás de cada sello, solo sobre foto.
    //
    // El velo baja el brillo general pero no aplana el contraste local: una foto
    // de comida tiene zonas claras justo del tamaño de un sello, y ahí el anillo
    // blanco desaparecía. Esto le da al sello su propio fondo, así que se lee
    // igual caiga sobre el plato o sobre la sombra del plato.
    if (conFoto) {
      disco(png, cx, cy + 2, radio * 1.14, { r: 0, g: 0, b: 0 }, 0.28);
    }

    if (i < llenos) {
      disco(png, cx, cy, radio, acento);
      if (icono) dibujarIcono(png, icono, cx, cy, radio * 2, tintaTilde, 1);
      else tilde(png, cx, cy, radio, tintaTilde);
    } else {
      // Relleno tenue además del anillo: el casillero vacío tiene que leerse
      // como un lugar que espera algo, no como un contorno flotando. Con icono,
      // se muestra tenue adentro: el cliente ve qué está por ganar.
      disco(png, cx, cy, radio, tinta, conFoto ? 0.2 : 0.16);
      anillo(png, cx, cy, radio, Math.max(3, radio * 0.1), tinta, 0.95);
      if (icono) dibujarIcono(png, icono, cx, cy, radio * 2, tinta, 0.4);
    }
  }

  return PNG.sync.write(png);
}
