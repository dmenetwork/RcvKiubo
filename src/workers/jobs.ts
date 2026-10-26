import { prisma } from "../db";
import { log } from "../log";
import { sincronizarTodos } from "./rcv-portal";
import { avisarCertificados, avisarPlazos, revisarPendientes } from "./seguimiento";
import { entregarPendientes } from "./webhooks";

/**
 * Los jobs periódicos, en el mismo proceso que la API (o en uno aparte con `JOBS_ACTIVOS`).
 *
 * No hace falta un candado global: los que tocan filas las RECLAMAN con `SKIP LOCKED` y un arriendo
 * (documentos, webhooks), y los avisos se deduplican por la clave del webhook. Dos procesos con los
 * jobs prendidos se reparten el trabajo en vez de duplicarlo.
 *
 * Cada job corre de a uno (no se solapa consigo mismo) y un error se loguea sin matar el ciclo.
 */

interface Job {
  nombre: string;
  cadaMs: number;
  correr: () => Promise<unknown>;
}

const DIA = 86_400_000;

export const JOBS: Job[] = [
  { nombre: "webhooks", cadaMs: 10_000, correr: () => entregarPendientes() },
  { nombre: "revision-sii", cadaMs: 60_000, correr: () => revisarPendientes() },
  { nombre: "avisos-plazo", cadaMs: 10 * 60_000, correr: () => avisarPlazos() },
  { nombre: "sincronizacion-rcv", cadaMs: 6 * 3_600_000, correr: () => sincronizarTodos() },
  { nombre: "avisos-certificado", cadaMs: 6 * 3_600_000, correr: () => avisarCertificados() },
  { nombre: "limpieza", cadaMs: DIA, correr: () => limpiar() },
];

/** Borra lo entregado viejo y suelta los crudos de correos que ya no se van a reprocesar. */
export async function limpiar(ahora = new Date()) {
  const entregas = await prisma.webhookEntrega.deleteMany({
    where: { estado: { in: ["entregado", "fallido"] }, creadoEn: { lt: new Date(ahora.getTime() - 30 * DIA) } },
  });
  const crudos = await prisma.correo.updateMany({
    where: { crudo: { not: null }, creadoEn: { lt: new Date(ahora.getTime() - 30 * DIA) } },
    data: { crudo: null },
  });
  return { entregasBorradas: entregas.count, crudosSoltados: crudos.count };
}

export function iniciarJobs(jobs: Job[] = JOBS): () => void {
  const timers: NodeJS.Timeout[] = [];
  let detenido = false;
  for (const job of jobs) {
    let corriendo = false;
    const tick = async () => {
      if (corriendo || detenido) return;
      corriendo = true;
      const t0 = Date.now();
      try {
        const r = await job.correr();
        log.debug("job", { job: job.nombre, ms: Date.now() - t0, r });
      } catch (e) {
        log.error("job falló", { job: job.nombre, error: e });
      } finally {
        corriendo = false;
      }
    };
    // Primer tick desfasado: al arrancar no salen todos a la vez.
    timers.push(setTimeout(tick, 2_000 + Math.floor(Math.random() * 5_000)));
    timers.push(setInterval(tick, job.cadaMs));
  }
  return () => {
    detenido = true;
    timers.forEach((t) => clearTimeout(t));
  };
}
