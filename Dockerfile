# Imagen de producción: build con esbuild, runtime Node 22 sin herramientas de compilación.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
RUN DATABASE_URL=postgresql://x:x@localhost/x npx prisma generate && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json .npmrc ./
# prisma (CLI) queda para `migrate deploy` al arrancar.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY prisma.config.ts ./
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:4100/health || exit 1
# Las migraciones se aplican antes de levantar: un deploy con schema viejo no llega a atender.
CMD ["sh", "-c", "npx prisma migrate deploy && node --enable-source-maps dist/index.js"]
