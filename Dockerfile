# Imagen de la API.
#
# Se compila con esbuild a un solo archivo (`pnpm build`) en vez de correr con
# `tsx`: transpilar en cada arranque suma segundos al despliegue y deja el
# compilador de TypeScript adentro de la imagen.

FROM node:20-slim AS builder

WORKDIR /app
RUN corepack enable

# Las dependencias primero, para que su capa se reuse mientras no cambien.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/console/package.json ./apps/console/
COPY apps/join/package.json ./apps/join/
COPY packages/db/package.json ./packages/db/
COPY packages/passes/package.json ./packages/passes/
COPY packages/rules/package.json ./packages/rules/
COPY packages/sdk/package.json ./packages/sdk/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------

FROM node:20-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# `node_modules` se copia entero y a la misma ruta absoluta: pnpm arma enlaces
# relativos hacia `.pnpm`, y moverlo de lugar los rompería. Trae dependencias de
# desarrollo que no hacen falta — se puede podar más adelante, pero primero que
# funcione.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Fly enruta a este puerto; el servidor lo lee de PORT.
ENV PORT=8080
EXPOSE 8080

# Sin init, Node queda como PID 1 y no reenvía las señales: un `fly deploy`
# esperaría el timeout completo en vez de cerrar limpio.
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/index.js"]
