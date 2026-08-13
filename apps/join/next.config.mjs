/** @type {import('next').NextConfig} */
export default {
  // El logo del comercio es una URL arbitraria que él configura, así que se
  // sirve con <img> plano en vez del optimizador de next/image, que exige
  // declarar los hosts de antemano.
  eslint: { ignoreDuringBuilds: true },
};
