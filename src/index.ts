import { config } from "./config";
import { prisma } from "./db";
import { crearApp } from "./http/app";
import { log } from "./log";
import { iniciarJobs } from "./workers/jobs";

const cfg = config();
const servidor = crearApp().listen(cfg.PORT, () => {
  log.info("RcvKiubo escuchando", { puerto: cfg.PORT, jobs: cfg.JOBS_ACTIVOS });
});
const detenerJobs = cfg.JOBS_ACTIVOS ? iniciarJobs() : () => {};
if (cfg.NODE_ENV === "production" && !cfg.llavesSii["300"]) {
  // Sin la llave del SII, el CAF de un DTE recibido no se puede probar: un CAF inventado pasa la
  // verificación local, y sólo QueryEstDte (el job de seguimiento) lo delata después.
  log.warn("SII_LLAVE_IDK_300 no está configurada: los DTE recibidos no se pueden verificar por completo");
}

// Apagado ordenado: deja de aceptar requests, corta los jobs y cierra el pool.
let cerrando = false;
async function cerrar(senal: string) {
  if (cerrando) return;
  cerrando = true;
  log.info("apagando", { senal });
  detenerJobs();
  servidor.close();
  const fuerza = setTimeout(() => process.exit(1), 15_000);
  fuerza.unref();
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void cerrar("SIGTERM"));
process.on("SIGINT", () => void cerrar("SIGINT"));
process.on("unhandledRejection", (e) => log.error("promesa rechazada sin manejar", { error: e }));
