/**
 * Escritor mínimo de ZIP, para armar el `.pkpass`.
 *
 * Un `.pkpass` es un zip común con `pass.json`, las imágenes, `manifest.json` y
 * `signature` adentro. Se escribe a mano por dos razones: las entradas van sin
 * comprimir —los pases son de pocos KB y el ahorro no paga la dependencia— y
 * así se controla cada byte, que importa cuando el consumidor es iOS y el
 * síntoma de un error es "el pase no se agrega", sin más detalle.
 *
 * El formato está en la especificación APPNOTE de PKWARE. Lo que se usa acá es
 * el subconjunto más viejo y más portable: método 0 (store), sin ZIP64, sin
 * descriptor de datos.
 *
 * Los tests lo verifican descomprimiendo con el `unzip` del sistema en vez de
 * con este mismo código: un zip que solo entiende quien lo escribió no prueba
 * nada.
 */

import { crc32 } from "node:zlib";

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Fecha fija en las entradas.
 *
 * Un zip con la hora de generación cambia en cada build aunque el contenido sea
 * idéntico, y entonces dos pases iguales dan hashes distintos. Con fecha fija
 * el mismo pase produce siempre el mismo archivo, que es lo que permite
 * comparar y cachear. iOS no mira estos campos.
 */
const DOS_DATE = 0x2821; // 2000-01-01
const DOS_TIME = 0x0000;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;

export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const sum = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4); // versión mínima para extraer: 2.0
    local.writeUInt16LE(0, 6); // sin flags: nombres en UTF-8 plano
    local.writeUInt16LE(0, 8); // método 0 = sin comprimir
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(size, 18); // comprimido
    local.writeUInt32LE(size, 22); // sin comprimir: iguales, porque no se comprime
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // sin campo extra

    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4); // versión que lo creó
    central.writeUInt16LE(20, 6); // versión mínima para extraer
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentario
    central.writeUInt16LE(0, 34); // número de disco
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    central.writeUInt32LE(offset, 42); // dónde empieza su header local

    centrals.push(central, name);

    offset += local.length + name.length + size;
  }

  const directory = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(0, 4); // disco actual
  end.writeUInt16LE(0, 6); // disco donde arranca el directorio
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16); // el directorio arranca donde terminan los datos
  end.writeUInt16LE(0, 20); // sin comentario

  return Buffer.concat([...locals, directory, end]);
}
