/**
 * Build de producción de la API.
 *
 * En producción no se corre con `tsx`: transpilar en cada arranque suma
 * segundos al despliegue, deja el compilador de TypeScript adentro de la imagen
 * y hace que un error de tipos aparezca al levantar en vez de al construir.
 *
 * Se empaqueta con esbuild en vez de emitir con `tsc` porque los paquetes del
 * workspace se importan por nombre (`@sophos/db`) y exportan TypeScript directo.
 * Emitir cada uno por separado obligaría a mantener `exports` y rutas de `dist`
 * en cinco package.json; empaquetando, esos paquetes entran resueltos y el
 * resultado es un solo archivo.
 *
 * Las dependencias de terceros quedan afuera: `pg` y PGlite traen binarios y
 * WASM que no se pueden empaquetar, y meter las demás adentro solo haría el
 * archivo más grande sin ganar nada — `node_modules` va a estar igual.
 *
 * Los paquetes `@sophos/*` sí entran, y esa distinción es el punto: la opción
 * `packages: "external"` de esbuild los dejaba afuera junto con los de terceros,
 * el build terminaba sin errores, y el artefacto reventaba al arrancar con
 * "Cannot find package @sophos/loyalty-sdk" — porque exportan TypeScript, que
 * Node no sabe cargar.
 */

/** Deja afuera todo lo de node_modules, pero empaqueta el workspace. */
const soloTerceros = {
  name: "solo-terceros-external",
  setup(build) {
    build.onResolve({ filter: /^[^./]|^\.[^./]|^\.\.[^/]/ }, (args) => {
      if (args.path.startsWith("@sophos/")) return null;
      if (args.path.startsWith("node:")) return { external: true };
      return { external: true };
    });
  },
};

import { cp, readFile, rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "dist";

await rm(outdir, { recursive: true, force: true });

const result = await build({
  entryPoints: ["apps/api/src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: `${outdir}/index.js`,
  plugins: [soloTerceros],
  sourcemap: true,
  // Sin esto, un `import` que no resuelve se convertiría en un require en
  // tiempo de ejecución y el error aparecería recién al arrancar.
  logLevel: "info",
  metafile: true,
});

/**
 * Las migraciones son archivos `.sql` que se leen del disco en tiempo de
 * ejecución, no módulos: hay que copiarlas. Si faltaran, el servicio arrancaría
 * y fallaría en la primera consulta contra una base vacía.
 */
await cp("packages/db/src/migrations", `${outdir}/migrations`, { recursive: true });

/**
 * Qué paquetes de terceros necesita el artefacto para arrancar.
 *
 * Se calculan del bundle en vez de mantenerlos a mano: una dependencia nueva en
 * cualquier paquete del workspace aparece acá sola. Si alguno falta en el
 * `package.json` de la raíz, el servicio compila y revienta al arrancar con
 * "Cannot find package", que es exactamente cómo se descubrió esto.
 */
const externos = new Set();
for (const [, meta] of Object.entries(result.metafile.outputs)) {
  for (const imp of meta.imports ?? []) {
    if (imp.external && !imp.path.startsWith("node:")) {
      externos.add(imp.path.startsWith("@") ? imp.path.split("/").slice(0, 2).join("/") : imp.path.split("/")[0]);
    }
  }
}

const raiz = JSON.parse(await readFile("package.json", "utf8"));
const produccion = new Set(Object.keys(raiz.dependencies ?? {}));
const desarrollo = new Set(Object.keys(raiz.devDependencies ?? {}));

const faltantes = [...externos].filter((d) => !produccion.has(d) && !desarrollo.has(d)).sort();
// Los que solo están en devDependencies llegan por `import()` dinámico y no
// corren en producción — PGlite es el caso: solo se carga cuando falta
// DATABASE_URL, y en producción el arranque aborta antes si falta. Se listan
// para que quede visible, no para frenar el build.
const soloDev = [...externos].filter((d) => !produccion.has(d) && desarrollo.has(d)).sort();

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`[build] ${outdir}/index.js — ${(bytes / 1024).toFixed(0)} KB`);
console.log(`[build] externos: ${[...externos].sort().join(", ")}`);
if (soloDev.length > 0) {
  console.log(`[build] solo en desarrollo (import dinámico): ${soloDev.join(", ")}`);
}

if (faltantes.length > 0) {
  console.error(
    `[build] FALTAN en las dependencias de la raíz: ${faltantes.join(", ")}\n` +
      "        El artefacto compila igual y falla al arrancar.",
  );
  process.exit(1);
}
