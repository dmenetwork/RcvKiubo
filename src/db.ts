import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

/**
 * Cliente Prisma único. Prisma 7 conecta por el adapter de node-postgres (sin motor nativo). Pool
 * acotado y timeouts de servidor y cliente: una consulta trabada no puede retener un request para
 * siempre. Bajo Vitest apunta a la base de tests.
 */

function crear(): PrismaClient {
  const url = process.env.VITEST ? (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL) : process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL no está definida.");
  const adapter = new PrismaPg({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    lock_timeout: 5_000,
    query_timeout: 35_000,
    // El adapter manda las fechas como texto UTC sin offset: con una sesión en otra zona horaria,
    // todo timestamp y toda comparación en SQL se correría 3-4 h.
    options: "-c TimeZone=UTC",
  });
  return new PrismaClient({ adapter });
}

const global = globalThis as unknown as { __prisma?: PrismaClient };
export const prisma: PrismaClient = global.__prisma ?? crear();
if (process.env.NODE_ENV !== "production") global.__prisma = prisma;

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
