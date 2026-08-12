import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    // Las suites que tocan la base levantan su propia instancia PGlite en
    // memoria. Correrlas en paralelo dentro del mismo proceso mezclaría el
    // estado, así que se aísla por archivo.
    pool: "forks",
    testTimeout: 30_000,
  },
});
