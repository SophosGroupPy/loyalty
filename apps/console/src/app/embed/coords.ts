/**
 * Lectura de coordenadas desde lo que el comercio tenga a mano.
 *
 * Vive fuera de `actions.ts` porque un módulo con `"use server"` solo puede
 * exportar funciones async: meter un helper síncrono ahí rompe el build de
 * toda la consola, no solo de la pantalla que lo usa.
 *
 * Nadie sabe de memoria la latitud de su local, pero todos saben copiar algo de
 * Google Maps. Se aceptan las dos formas en que eso llega.
 */
export function parseCoords(entrada: string): { lat: number; lng: number } | null {
  const texto = entrada.trim();

  // URL de Maps: .../@-25.2965,-57.5759,17z
  const url = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(texto);
  if (url) return { lat: Number(url[1]), lng: Number(url[2]) };

  // El par que aparece al hacer clic derecho sobre el punto: "-25.2965, -57.5759"
  const par = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(texto);
  if (par) return { lat: Number(par[1]), lng: Number(par[2]) };

  return null;
}
