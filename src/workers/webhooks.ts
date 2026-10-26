import { Agent, fetch as undiciFetch } from "undici";
import { config } from "../config";
import { firmarWebhook } from "../core/credenciales";
import { lookupSeguro } from "../core/red";
import { prisma } from "../db";
import { noEncontrado } from "../errores";
import type { EstadoEntrega } from "../generated/prisma/client";
import { log } from "../log";
import { abrirSecretoWebhook, type Actor } from "./consumidores";

/**
 * Webhooks con bandeja de salida (outbox): encolar es una fila en la misma base que el cambio, y un
 * job las entrega con reintentos. Si el consumidor está caído, nada se pierde; si el proceso muere a
 * mitad de una entrega, la fila vuelve a estar disponible cuando vence su arriendo.
 *
 * Entrega "al menos una vez": el consumidor deduplica por `id` (va en el cuerpo y en la cabecera).
 */

export const EVENTOS = [
  "documento.recibido",
  "documento.alerta",
  "documento.evento",
  "documento.plazo_por_vencer",
  "documento.aceptado_tacito",
  "rcv.importado",
  "rcv.sincronizado",
  "rcv.sincronizacion_fallida",
  "certificado.por_vencer",
  "correo.error",
  "webhook.prueba",
] as const;
export type Evento = (typeof EVENTOS)[number];

const MAX_INTENTOS = 12;
const ARRIENDO_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 10_000;

/** Encola un evento. `clave` deduplica: el mismo aviso para el mismo objeto se encola una sola vez. */
export async function encolar(
  consumidorId: string,
  evento: Evento,
  clave: string,
  datos: Record<string, unknown>,
  db: Pick<typeof prisma, "consumidor" | "webhookEntrega"> = prisma,
): Promise<void> {
  const c = await db.consumidor.findUnique({ where: { id: consumidorId }, select: { webhookUrl: true, activo: true } });
  if (!c?.webhookUrl || !c.activo) return;
  const payload = JSON.parse(JSON.stringify({ evento, datos }, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
  // ON CONFLICT DO NOTHING (y no un catch de P2002): dentro de una transacción, una violación de
  // unicidad aborta la transacción entera; ya encolado = deduplicado a propósito.
  await db.webhookEntrega.createMany({ data: [{ consumidorId, evento, clave: `${evento}:${clave}`, payload }], skipDuplicates: true });
}

/** Espera antes del intento n (1-indexado): 1, 2, 4, … minutos, con techo de 6 horas. */
export function esperaReintento(intentos: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, intentos - 1), 6 * 3_600_000);
}

/**
 * El despachador de las entregas: conecta sólo a direcciones públicas (`lookupSeguro` valida la IP
 * resuelta al CONECTAR, así que ni un DNS que apunta a la red interna ni un rebinding pasan).
 */
let agente: Agent | null = null;
function fetchSeguro(): typeof fetch {
  if (config().WEBHOOK_PERMITIR_INSEGURO) return fetch;
  agente ??= new Agent({ connect: { lookup: lookupSeguro as never }, headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });
  const a = agente;
  return ((url: string, init: RequestInit) => undiciFetch(url, { ...(init as object), dispatcher: a } as never)) as unknown as typeof fetch;
}

/**
 * Entrega un lote de pendientes. Las filas se RECLAMAN atómicamente (`FOR UPDATE SKIP LOCKED` y un
 * arriendo): dos procesos corriendo el job no mandan el mismo webhook dos veces a la vez.
 *
 * Reparto justo: a lo más `porConsumidor` entregas de cada consumidor por ciclo, y los consumidores
 * en PARALELO. Un endpoint lento de un consumidor no frena los avisos de plazo de los demás.
 */
export async function entregarPendientes(opts: { lote?: number; porConsumidor?: number; ahora?: Date; fetch?: typeof fetch } = {}): Promise<number> {
  const ahora = opts.ahora ?? new Date();
  const f = opts.fetch ?? fetchSeguro();
  const reclamadas = await prisma.$queryRaw<Array<{ id: string; consumidor_id: string }>>`
    UPDATE webhook_entregas SET proximo_intento_en = ${new Date(ahora.getTime() + ARRIENDO_MS)}
    WHERE id IN (
      SELECT w.id FROM webhook_entregas w
      WHERE w.id IN (
        SELECT x.id FROM (
          SELECT id, row_number() OVER (PARTITION BY consumidor_id ORDER BY proximo_intento_en) AS n
          FROM webhook_entregas
          WHERE estado = 'pendiente' AND proximo_intento_en <= ${ahora}
        ) x
        WHERE x.n <= ${opts.porConsumidor ?? 5}
      )
      ORDER BY w.proximo_intento_en
      LIMIT ${opts.lote ?? 100}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, consumidor_id`;
  const porConsumidor = new Map<string, string[]>();
  for (const r of reclamadas) porConsumidor.set(r.consumidor_id, [...(porConsumidor.get(r.consumidor_id) ?? []), r.id]);
  await Promise.all(
    [...porConsumidor.values()].map(async (ids) => {
      for (const id of ids) await entregarUna(id, ahora, f);
    }),
  );
  return reclamadas.length;
}

async function entregarUna(id: string, ahora: Date, f: typeof fetch): Promise<void> {
  const e = await prisma.webhookEntrega.findUnique({ where: { id }, include: { consumidor: true } });
  if (!e) return;
  const intentos = e.intentos + 1;
  const { webhookUrl, webhookSecretoSellado } = e.consumidor;
  if (!webhookUrl || !webhookSecretoSellado || !e.consumidor.activo) {
    await prisma.webhookEntrega.update({ where: { id }, data: { estado: "fallido", intentos, ultimoError: "el consumidor ya no tiene webhook" } });
    return;
  }
  const cuerpo = JSON.stringify({ id: e.id, creadoEn: e.creadoEn.toISOString(), ...(e.payload as object) });
  let status: number | null = null;
  let error: string | null = null;
  try {
    const res = await f(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "RcvKiubo-Webhooks/1",
        "X-RcvKiubo-Evento": e.evento,
        "X-RcvKiubo-Entrega": e.id,
        "X-RcvKiubo-Firma": firmarWebhook(abrirSecretoWebhook(e.consumidorId, webhookSecretoSellado), cuerpo, new Date()),
      },
      body: cuerpo,
      // Un redirect llevaría el cuerpo firmado a otro destino que el configurado.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = res.status;
    await res.body?.cancel().catch(() => {});
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    const causa = (err as { cause?: { message?: string } }).cause?.message;
    error = causa ?? (err instanceof Error ? err.message : String(err));
  }
  if (!error) {
    await prisma.webhookEntrega.update({ where: { id }, data: { estado: "entregado", intentos, ultimoStatus: status, ultimoError: null, entregadoEn: new Date() } });
    return;
  }
  const fallido = intentos >= MAX_INTENTOS;
  await prisma.webhookEntrega.update({
    where: { id },
    data: {
      estado: fallido ? "fallido" : "pendiente",
      intentos,
      ultimoStatus: status,
      ultimoError: error.slice(0, 500),
      proximoIntentoEn: new Date(ahora.getTime() + esperaReintento(intentos)),
    },
  });
  if (fallido) log.warn("webhook descartado tras los reintentos", { entrega: id, consumidor: e.consumidorId, evento: e.evento, error });
}

export async function listarEntregas(actor: Actor, filtro: { estado?: EstadoEntrega; limite?: number }) {
  return prisma.webhookEntrega.findMany({
    where: { consumidorId: actor.consumidorId, ...(filtro.estado ? { estado: filtro.estado } : {}) },
    orderBy: { creadoEn: "desc" },
    take: Math.min(filtro.limite ?? 50, 200),
    select: { id: true, evento: true, estado: true, intentos: true, ultimoStatus: true, ultimoError: true, proximoIntentoEn: true, entregadoEn: true, creadoEn: true },
  });
}

/** Vuelve a poner en cola una entrega (típicamente una `fallida` tras arreglar el endpoint). */
export async function reintentarEntrega(actor: Actor, id: string): Promise<void> {
  const r = await prisma.webhookEntrega.updateMany({
    where: { id, consumidorId: actor.consumidorId },
    data: { estado: "pendiente", proximoIntentoEn: new Date(), intentos: 0 },
  });
  if (r.count === 0) throw noEncontrado("La entrega");
}

export async function enviarPrueba(actor: Actor): Promise<void> {
  const c = await prisma.consumidor.findUniqueOrThrow({ where: { id: actor.consumidorId }, select: { webhookUrl: true } });
  if (!c.webhookUrl) throw noEncontrado("El webhook (configúralo con PUT /v1/webhook)");
  // A lo más una prueba por minuto: `probar` no puede servir para llenar la cola.
  await encolar(actor.consumidorId, "webhook.prueba", `${Math.floor(Date.now() / 60_000)}`, { mensaje: "Prueba de webhook de RcvKiubo" });
}
