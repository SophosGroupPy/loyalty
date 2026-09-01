import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    // Las suites que tocan la base levantan su propia instancia PGlite en
    // memoria. Correrlas en paralelo dentro del mismo proceso mezclaría el
    // estado, así que se aísla por archivo.
    pool: "forks",
    poolOptions: {
      // Cada fork levanta su propio Postgres en WASM, que come CPU y memoria.
      // Con un fork por núcleo, 18 archivos se pelean por la máquina y algunos
      // tests pasan de 10 segundos y fallan por timeout — un fallo que no dice
      // nada del código y que aparece al azar. Cuatro deja la suite estable a
      // cambio de algo de reloj.
      forks: { minForks: 1, maxForks: 4 },
    },
    testTimeout: 30_000,
  },
});
