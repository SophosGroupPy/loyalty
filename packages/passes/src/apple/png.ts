/**
 * PNG de un color sólido, escrito a mano.
 *
 * Existe por una restricción de Apple: **sin `icon.png` el pase no se agrega**,
 * y el mensaje que muestra iOS no dice cuál es el problema. Si un comercio no
 * cargó logo, o si la descarga de su logo falla, es preferible emitir la tarjeta
 * con un cuadrado de su color de marca a no emitirla.
 *
 * No se usa una librería de imágenes porque para un color sólido no hace falta:
 * un PNG es una firma, tres chunks y sus CRC. Traer una dependencia de imágenes
 * al servidor para pintar un cuadrado sería desproporcionado.
 */

import { crc32, deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  // El CRC cubre el tipo y los datos, no el largo.
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

/** `#RRGGBB` a triplete. Devuelve gris medio si el color no se entiende. */
function parseHex(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [128, 128, 128];

  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function solidPng(size: number, hexColor: string): Buffer {
  const rgb = Buffer.from(parseHex(hexColor));

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profundidad de bits
  ihdr[9] = 2; // tipo de color 2 = RGB sin canal alfa
  // Los bytes 10-12 quedan en cero: compresión, filtro e interlazado estándar.

  // Cada fila arranca con el byte de filtro (0 = sin filtro) y sigue con los
  // píxeles. Es el formato crudo que espera el deflate del PNG.
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => rgb))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Un PNG empieza siempre con la misma firma de ocho bytes. */
export function isPng(data: Buffer): boolean {
  return data.length > 8 && data.subarray(0, 8).equals(SIGNATURE);
}
