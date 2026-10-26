import { createHash } from "node:crypto";
import { analizarCorreo } from "../core/dte-intercambio";
import { prisma } from "../db";
import { ErrorHttp, noEncontrado } from "../errores";
import type { Correo } from "../generated/prisma/client";
import { ingresarDtes, type ResultadoIngreso } from "./documentos";
import { encolar } from "./webhooks";

/**
 * Entrada de la casilla de intercambio DTE. Mismo contrato que el Email Worker de Kiubo
 * (`belen-abos/deploy/email-worker`): POST del crudo RFC 822 con `x-intercambio-secret` y
 * `x-intercambio-to`, y un latido GET. El Worker del repo (`email-worker/`) es ese mismo archivo.
 *
 * - Se enruta SÓLO por la casilla (`correoIntercambio`, que asigna el operador). Nunca por el RUT
 *   receptor de los documentos: dos consumidores pueden registrar el mismo RUT, y adivinar le
 *   entregaría las facturas de uno al otro.
 * - Idempotente por (sha256 del crudo, casilla): el Worker reintenta lo que no pudo entregar, y
 *   reintentar algo que sí entró no duplica. Un correo que quedó `sin_destino` o `error` SÍ se
 *   reprocesa si vuelve a llegar (o con `reprocesarCorreo`): quizás ya se asignó la casilla.
 */

export const MAX_BYTES_CORREO = 26 * 1024 * 1024;
/** El crudo se guarda sólo si no se pudo procesar, y con tope: es para reprocesar, no para archivar. */
const MAX_BYTES_CRUDO_ERROR = 5 * 1024 * 1024;
const REPROCESABLES = new Set(["sin_destino", "error"]);

export interface ResultadoCorreo {
  correoId: string;
  estado: string;
  duplicado: boolean;
  contribuyenteId: string | null;
  ingreso: ResultadoIngreso | null;
}

export async function recibirCorreo(crudo: Buffer, destinatario: string, ahora = new Date()): Promise<ResultadoCorreo> {
  if (crudo.length === 0) throw new ErrorHttp(400, "CORREO_VACIO", "El correo llegó vacío.");
  if (crudo.length > MAX_BYTES_CORREO) throw new ErrorHttp(413, "CORREO_DEMASIADO_GRANDE", "El correo supera 26 MB.");
  const casilla = destinatario.trim().toLowerCase().slice(0, 320);
  const sha256 = createHash("sha256").update(crudo).digest("hex");
  const previo = await prisma.correo.findUnique({ where: { sha256_destinatario: { sha256, destinatario: casilla } } });
  if (previo && !REPROCESABLES.has(previo.estado)) {
    return { correoId: previo.id, estado: previo.estado, duplicado: true, contribuyenteId: previo.contribuyenteId, ingreso: null };
  }
  return procesar(crudo, casilla, sha256, previo, ahora);
}

async function procesar(crudo: Buffer, casilla: string, sha256: string, previo: Correo | null, ahora: Date): Promise<ResultadoCorreo> {
  const analisis = await analizarCorreo(new Uint8Array(crudo));
  const destino = casilla ? await prisma.contribuyente.findUnique({ where: { correoIntercambio: casilla } }) : null;
  const c = destino?.activo ? destino : null;

  let ingreso: ResultadoIngreso | null = null;
  let estado: string = analisis.estado;
  let error = analisis.error;
  if (analisis.documentos.length > 0) {
    if (!c) {
      estado = "sin_destino";
      error = [`ninguna casilla activa coincide con ${casilla || "(vacía)"}`, error].filter(Boolean).join(" · ");
    } else {
      ingreso = await ingresarDtes(c, analisis.documentos.map((d) => d.dte), ahora);
      if (ingreso.problemas.length) error = [error, ...ingreso.problemas].filter(Boolean).join(" · ").slice(0, 4000);
    }
  }

  const conservarCrudo = REPROCESABLES.has(estado) && crudo.length <= MAX_BYTES_CRUDO_ERROR;
  const datos = {
    contribuyenteId: c?.id ?? null,
    remitente: analisis.remitente?.slice(0, 320) ?? null,
    asunto: analisis.asunto?.slice(0, 500) ?? null,
    messageId: analisis.messageId?.slice(0, 500) ?? null,
    estado,
    documentos: ingreso?.documentos.length ?? 0,
    error,
    crudo: conservarCrudo ? new Uint8Array(crudo) : null,
  };
  const fila = previo
    ? await prisma.correo.update({ where: { id: previo.id }, data: datos })
    : await prisma.correo.create({ data: { ...datos, sha256, destinatario: casilla } }).catch(async (e: { code?: string }) => {
        // Dos entregas simultáneas del mismo correo: la otra ganó, y los documentos se deduplicaron solos.
        if (e.code === "P2002") return prisma.correo.findUniqueOrThrow({ where: { sha256_destinatario: { sha256, destinatario: casilla } } });
        throw e;
      });

  if (c && (estado === "error" || (ingreso?.problemas.length ?? 0) > 0)) {
    await encolar(c.consumidorId, "correo.error", fila.id, { contribuyenteId: c.id, remitente: fila.remitente, asunto: fila.asunto, estado, error });
  }
  return { correoId: fila.id, estado, duplicado: false, contribuyenteId: c?.id ?? null, ingreso };
}

/** Reprocesa un correo guardado con su crudo. Para el operador: tras asignar la casilla que faltaba. */
export async function reprocesarCorreo(id: string, ahora = new Date()): Promise<ResultadoCorreo> {
  const previo = await prisma.correo.findUnique({ where: { id } });
  if (!previo) throw noEncontrado("El correo");
  if (!previo.crudo) throw new ErrorHttp(409, "SIN_CRUDO", "Ese correo no conserva el crudo (se procesó bien, o se limpió por antigüedad).");
  return procesar(Buffer.from(previo.crudo), previo.destinatario, previo.sha256, previo, ahora);
}

export async function correosParaRevisar(limite = 100) {
  return prisma.correo.findMany({
    where: { estado: { in: [...REPROCESABLES] } },
    orderBy: { creadoEn: "desc" },
    take: limite,
    select: { id: true, destinatario: true, remitente: true, asunto: true, estado: true, error: true, creadoEn: true },
  });
}

export async function registrarLatido(pendientes: number | null, masAntiguo: number | null, ahora = new Date()): Promise<void> {
  const datos = {
    ultimoEn: ahora,
    ...(pendientes !== null ? { pendientes } : {}),
    ...(masAntiguo !== null ? { masAntiguo: new Date(masAntiguo) } : pendientes === 0 ? { masAntiguo: null } : {}),
  };
  await prisma.latido.upsert({ where: { id: "email-worker" }, create: { id: "email-worker", ...datos }, update: datos });
}

export async function estadoBuzon(ahora = new Date()) {
  const l = await prisma.latido.findUnique({ where: { id: "email-worker" } });
  const horasSinLatido = l ? (ahora.getTime() - l.ultimoEn.getTime()) / 3_600_000 : null;
  return {
    ultimoLatido: l?.ultimoEn.toISOString() ?? null,
    pendientesEnWorker: l?.pendientes ?? null,
    pendienteMasAntiguo: l?.masAntiguo?.toISOString() ?? null,
    // Más de 2 h sin latido: el Worker, el túnel o la clave están mal. Sin esto, "no llegaron
    // facturas" se ve igual que "el buzón está caído".
    sano: horasSinLatido !== null && horasSinLatido < 2,
  };
}

export async function listarCorreos(contribuyenteId: string, limite = 50) {
  return prisma.correo.findMany({
    where: { contribuyenteId },
    orderBy: { creadoEn: "desc" },
    take: Math.min(Math.max(limite, 1), 200),
    select: { id: true, destinatario: true, remitente: true, asunto: true, estado: true, documentos: true, error: true, creadoEn: true },
  });
}
