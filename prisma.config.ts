import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7 saca la URL del schema: la usa el CLI (migrate, studio). El runtime conecta por el
// adapter de node-postgres (src/db.ts). Con un config presente Prisma NO carga .env solo: dotenv.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
