/**
 * La consola vive dentro de un iframe de ElMenu, Noctu o FactuFast.
 *
 * `frame-ancestors` es lo que impide que **cualquier** sitio la embeba. Sin
 * esto, alguien podría montar una página que la muestre y superponer controles
 * invisibles para que el dueño de un comercio ejecute acciones sin saberlo.
 *
 * Se configura por entorno porque los dominios de los productos cambian entre
 * desarrollo y producción. El default de desarrollo permite localhost; en
 * producción hay que setear EMBED_ALLOWED_ANCESTORS con los dominios reales.
 */
const ancestors =
  process.env.EMBED_ALLOWED_ANCESTORS ??
  (process.env.NODE_ENV === "production" ? "'none'" : "'self' http://localhost:*");

/** @type {import('next').NextConfig} */
export default {
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: `frame-ancestors ${ancestors};` },
          // La consola muestra la base de clientes de un comercio. Que no se
          // quede cacheada en un proxy compartido.
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};
