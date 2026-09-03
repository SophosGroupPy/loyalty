/**
 * Formato de fechas compartido entre las dos plataformas.
 *
 * Vive suelto y no dentro de `apple/` o `google/` porque las dos lo usan, y
 * hacer que una importe de la otra ataría dos capas que hoy no se conocen.
 */

/** Meses en castellano: `toLocaleDateString` depende del ICU del runtime. */
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/**
 * "2021-08-15" → "agosto 2021". Devuelve null si la fecha no se entiende.
 *
 * En UTC a propósito: la fecha de alta es un día, no un instante, y leerla en el
 * huso del servidor la correría un día para quien se dio de alta cerca de la
 * medianoche.
 */
export function mesYAnio(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
