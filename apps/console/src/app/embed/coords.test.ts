import { describe, expect, it } from "vitest";

import { parseCoords } from "./coords";

/**
 * Nadie sabe de memoria la latitud de su local. Lo que sí sabe hacer todo el
 * mundo es copiar algo de Google Maps, así que este parser define qué tan
 * usable es la pantalla de ubicaciones.
 */
describe("lectura de coordenadas", () => {
  it("lee el par que aparece al hacer clic derecho en el mapa", () => {
    expect(parseCoords("-25.2965, -57.5759")).toEqual({ lat: -25.2965, lng: -57.5759 });
    expect(parseCoords("-25.2965,-57.5759")).toEqual({ lat: -25.2965, lng: -57.5759 });
    // Con espacios de sobra, como queda al pegar.
    expect(parseCoords("  -25.2965 ,  -57.5759  ")).toEqual({
      lat: -25.2965,
      lng: -57.5759,
    });
  });

  it("extrae las coordenadas de una URL larga de Google Maps", () => {
    expect(
      parseCoords("https://www.google.com/maps/place/Carmelitas/@-25.2789,-57.5641,17z/data=!3m1"),
    ).toEqual({ lat: -25.2789, lng: -57.5641 });
  });

  it("acepta coordenadas positivas, para cuando el producto salga de Paraguay", () => {
    expect(parseCoords("40.4168, -3.7038")).toEqual({ lat: 40.4168, lng: -3.7038 });
  });

  it("devuelve null en vez de adivinar", () => {
    // Un link acortado de Maps no trae las coordenadas: hay que resolverlo antes.
    // Inventar un valor pondría la geocerca en el lugar equivocado sin avisar.
    for (const entrada of ["", "Villa Morra", "https://maps.app.goo.gl/abc123", "25", "a, b"]) {
      expect(parseCoords(entrada), `aceptó "${entrada}"`).toBeNull();
    }
  });
});
