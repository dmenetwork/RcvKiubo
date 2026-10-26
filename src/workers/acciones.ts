import { TIPOS_REGISTRO_RECLAMO, type AccionReclamo, type DocumentoSii } from "../core/registro-reclamo";
import { rutSii } from "../core/rut";
import { prisma } from "../db";
import { ErrorHttp } from "../errores";
import type { Contribuyente } from "../generated/prisma/client";
import type { ConsultaEstadoDte } from "../core/estado-dte";
import { ErrorSii } from "../sii/cliente";
import { contextoSii, firmanteDe } from "./certificados";
import type { Actor } from "./consumidores";
import { contribuyenteDe } from "./contribuyentes";
import { documentoDe, serializarDocumento } from "./documentos";
import { refrescarDocumento } from "./seguimiento";
import { clienteSii } from "./sii";
import { encolar } from "./webhooks";

/**
 * Acciones de aceptación/reclamo y consultas directas al SII.
 *
 * Toda acción pedida queda en `acciones_registradas` con lo que contestó el SII —también los
 * rechazos y los errores—: "¿quién reclamó esta factura y qué dijo el SII?" tiene que tener respuesta.
 */

function docSii(rutEmisor: string, tipoDte: number, folio: number): DocumentoSii {
  const rut = rutSii(rutEmisor);
  if (!rut) throw new ErrorHttp(400, "RUT_INVALIDO", `El RUT emisor ${rutEmisor} no es válido.`);
  if (!TIPOS_REGISTRO_RECLAMO.has(tipoDte)) {
    throw new ErrorHttp(422, "TIPO_SIN_REGISTRO", `El registro del SII sólo opera los tipos 33, 34 y 43; este es tipo ${tipoDte}.`);
  }
  return { rutEmisor: rut, tipoDoc: tipoDte, folio };
}

/** Registra la acción en el SII y deja constancia. Si el documento está guardado, lo actualiza y avisa. */
export async function registrarAccion(
  actor: Actor,
  c: Contribuyente,
  doc: DocumentoSii,
  accion: AccionReclamo,
  documentoId: string | null,
) {
  const base = { contribuyenteId: c.id, documentoId, rutEmisorDoc: doc.rutEmisor, tipoDte: doc.tipoDoc, folio: doc.folio, accion, apiKeyId: actor.apiKeyId };
  let r;
  try {
    r = await clienteSii().registrarAccion(contextoSii(c), doc, accion);
  } catch (e) {
    await prisma.accionRegistrada.create({ data: { ...base, resultado: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 500) } });
    throw e;
  }
  await prisma.accionRegistrada.create({ data: { ...base, codigo: r.codigo, glosa: r.glosa, resultado: r.resultado } });

  let documento = null;
  if (documentoId && (r.resultado === "registrado" || r.resultado === "ya_estaba")) {
    // El evento vigente lo recalcula el historial del SII (un ERM después de un ACD no "baja" a ERM
    // sin mirar el resto). Si la consulta falla, la acción igual quedó registrada.
    const d = await prisma.documento.findUnique({ where: { id: documentoId } });
    if (d) {
      try {
        documento = serializarDocumento(await refrescarDocumento(c, d), { horasAviso: c.horasAvisoPlazo });
      } catch {
        const anotado = await prisma.documento.update({ where: { id: d.id }, data: { eventoReceptor: d.eventoReceptor ?? accion, proximaRevisionEn: new Date() } });
        documento = serializarDocumento(anotado, { horasAviso: c.horasAvisoPlazo });
        if (!d.eventoReceptor) {
          await encolar(c.consumidorId, "documento.evento", `${d.id}:${accion}`, { contribuyenteId: c.id, evento: accion, anterior: null, documento });
        }
      }
    }
  }
  return { codigo: r.codigo, glosa: r.glosa, resultado: r.resultado, documento };
}

export async function registrarAccionDocumento(actor: Actor, contribuyenteId: string, documentoId: string, accion: AccionReclamo) {
  const { c, d } = await documentoDe(actor, contribuyenteId, documentoId);
  if (d.operacion !== "COMPRA") {
    throw new ErrorHttp(422, "SOLO_RECEPTOR", "Aceptar o reclamar lo hace el RECEPTOR: este documento es una venta del contribuyente.");
  }
  return registrarAccion(actor, c, docSii(d.rutContraparte, d.tipoDte, d.folio), accion, d.id);
}

export async function refrescarDocumentoPedido(actor: Actor, contribuyenteId: string, documentoId: string) {
  const { c, d } = await documentoDe(actor, contribuyenteId, documentoId);
  return serializarDocumento(await refrescarDocumento(c, d), { horasAviso: c.horasAvisoPlazo });
}

// ── Consultas directas (sin documento guardado) ──────────────────────────────────────────────
// Para el consumidor que ya tiene sus documentos (Kiubo) y sólo quiere hablar con el SII.

export async function accionDirecta(actor: Actor, contribuyenteId: string, p: { rutEmisor: string; tipoDte: number; folio: number; accion: AccionReclamo }) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  const doc = docSii(p.rutEmisor, p.tipoDte, p.folio);
  const guardado = await prisma.documento.findUnique({
    where: { contribuyenteId_operacion_rutContraparte_tipoDte_folio: { contribuyenteId: c.id, operacion: "COMPRA", rutContraparte: doc.rutEmisor, tipoDte: doc.tipoDoc, folio: doc.folio } },
    select: { id: true },
  });
  return registrarAccion(actor, c, doc, p.accion, guardado?.id ?? null);
}

export async function eventosDirecto(actor: Actor, contribuyenteId: string, p: { rutEmisor: string; tipoDte: number; folio: number }) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  return clienteSii().listarEventos(contextoSii(c), docSii(p.rutEmisor, p.tipoDte, p.folio));
}

export async function cedibleDirecto(actor: Actor, contribuyenteId: string, p: { rutEmisor: string; tipoDte: number; folio: number }) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  return clienteSii().consultarCedible(contextoSii(c), docSii(p.rutEmisor, p.tipoDte, p.folio));
}

export async function fechaRecepcionDirecto(actor: Actor, contribuyenteId: string, p: { rutEmisor: string; tipoDte: number; folio: number }) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  const fecha = await clienteSii().fechaRecepcion(contextoSii(c), docSii(p.rutEmisor, p.tipoDte, p.folio));
  return { fechaRecepcion: fecha, plazoVence: fecha ? new Date(new Date(fecha).getTime() + 8 * 86_400_000).toISOString() : null };
}

export async function estadoDteDirecto(
  actor: Actor,
  contribuyenteId: string,
  p: Omit<ConsultaEstadoDte, "rutConsultante">,
) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  const consulta = {
    rutEmisor: rutSii(p.rutEmisor),
    rutReceptor: rutSii(p.rutReceptor),
    tipoDte: p.tipoDte,
    folio: p.folio,
    fechaEmision: p.fechaEmision,
    montoTotal: p.montoTotal,
  };
  if (!consulta.rutEmisor || !consulta.rutReceptor) throw new ErrorHttp(400, "RUT_INVALIDO", "RUT emisor o receptor inválido.");
  const ctx = contextoSii(c);
  try {
    const { rutTitular } = await firmanteDe(c.id);
    return await clienteSii().estadoDte(ctx, { ...consulta, rutConsultante: rutTitular });
  } catch (e) {
    if (e instanceof Error && !(e instanceof ErrorSii) && !(e instanceof ErrorHttp)) throw new ErrorHttp(400, "CONSULTA_INVALIDA", e.message);
    throw e;
  }
}

export async function accionesRegistradas(actor: Actor, contribuyenteId: string, limite = 100) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  return prisma.accionRegistrada.findMany({ where: { contribuyenteId: c.id }, orderBy: { creadoEn: "desc" }, take: Math.min(limite, 500) });
}
