/**
 * Entorno de los tests de integración: base de tests real (Postgres), secretos de prueba y un SII
 * falso. Se importa ANTES que cualquier módulo que lea la configuración.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { reiniciarConfig } from "../config";
import { llaveSiiDePrueba } from "../core/__fixtures__/material";

if (!process.env.DATABASE_URL_TEST) {
  throw new Error("Los tests de integración necesitan DATABASE_URL_TEST (npm run db:up; ver .env.example).");
}

/** La llave que hace de "SII" firmando la FRMA de los CAF de prueba. */
export const SII_PRUEBA = llaveSiiDePrueba();

process.env.SELLO_LLAVES = `1:${randomBytes(32).toString("base64")}`;
process.env.ADMIN_TOKEN = "admin-token-de-pruebas-0123456789abcdef";
process.env.INTERCAMBIO_SECRET = "intercambio-secreto-de-pruebas-0123456789";
process.env.SII_LLAVE_IDK_100 = SII_PRUEBA.publica;
process.env.SII_LLAVE_IDK_300 = "";
process.env.WEBHOOK_PERMITIR_INSEGURO = "true";
process.env.JOBS_ACTIVOS = "false";
reiniciarConfig();

const TABLAS = [
  "webhook_entregas",
  "acciones_registradas",
  "importaciones_rcv",
  "correos",
  "documentos",
  "certificados",
  "contribuyentes",
  "api_keys",
  "auditoria",
  "latidos",
  "consumidores",
];

export async function limpiarBase(): Promise<void> {
  const { prisma } = await import("../db");
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLAS.join(", ")} CASCADE`);
}
