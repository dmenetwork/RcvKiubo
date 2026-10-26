import { vencimientoPlazo } from "../core/plazos";
import { TIPOS_REGISTRO_RECLAMO, eventoVigente } from "../core/registro-reclamo";
import { prisma } from "../db";
import type { Contribuyente, Documento, Prisma } from "../generated/prisma/client";
import { log } from "../log";
import { ErrorSii } from "../sii/cliente";
import { contextoSii } from "./certificados";
import { serializarDocumento } from "./documentos";
import { clienteSii } from "./sii";
import { encolar } from "./webhooks";

/**
 * Seguimiento de cada documento contra el SII: fecha de recepción (el reloj de los 8 días),
 * historial de eventos, cedibilidad y estado del DTE. Lo corre el job sobre los documentos cuya
 * `proximaRevisionEn` venció, y una ruta cuando un consumidor lo pide a mano.
 */

const HORA = 3_600_000;
const DIA = 24 * HORA;
/** Revisiones FALLIDAS seguidas tras las que el seguimiento se detiene (y avisa). Se retoma al cargar certificado. */
export const MAX_ERRORES_REVISION = 15;
/** Arriendo de un lote reclamado: tiene que cubrir el peor caso del lote (10 docs × 4 llamadas × reintentos). */
const ARRIENDO_MS = 20 * 60_000;

/** El RUT del EMISOR del documento: el proveedor en una compra, el propio contribuyente en una venta. */
export const rutEmisorDe = (c: Pick<Contribuyente, "rut">, d: Pick<Documento, "operacion" | "rutContraparte">) =>
  d.operacion === "COMPRA" ? d.rutContraparte : c.rut;

/** Las clases de `QueryEstDte` que son una mala noticia sobre un documento recibido. */
const CLASES_ALERTA = new Set(["no_coincide", "anulado", "invalido"]);

type ParaAgendar = Pick<Documento, "operacion" | "tipoDte" | "eventoReceptor" | "fechaRecepcionSii" | "claseEstadoSii" | "creadoEn" | "intentosRevision">;

/** ¿Todavía se espera algo que el SII aún no tiene (la recepción, o que el DTE aparezca)? */
export function esperandoAlSii(d: ParaAgendar): boolean {
  return (TIPOS_REGISTRO_RECLAMO.has(d.tipoDte) && !d.fechaRecepcionSii) || (d.operacion === "COMPRA" && d.claseEstadoSii === "no_recibido");
}

/**
 * Cuándo volver a mirar el documento. `null` cuando ya no queda nada que el SII pueda cambiar.
 *
 * - Sin fecha de recepción o "no recibido" en el SII: backoff 1, 2, 4… h (techo 24 h) por 30 días,
 *   según `intentosRevision` (revisiones seguidas esperando). Un DTE recién emitido puede tardar.
 * - Compra con registro (33/34/43) sin evento y con plazo abierto: cada 6 h hasta 1 h después del
 *   vencimiento, para ver la aceptación tácita o un evento de último minuto.
 */
export function proximaRevision(d: ParaAgendar, ahora: Date): Date | null {
  if (esperandoAlSii(d)) {
    if (ahora.getTime() - d.creadoEn.getTime() > 30 * DIA) return null;
    return new Date(ahora.getTime() + Math.min(HORA * 2 ** Math.min(Math.max(d.intentosRevision - 1, 0), 5), DIA));
  }
  if (TIPOS_REGISTRO_RECLAMO.has(d.tipoDte) && !d.eventoReceptor && d.fechaRecepcionSii) {
    const finVigilancia = vencimientoPlazo(d.fechaRecepcionSii).getTime() + HORA;
    if (ahora.getTime() >= finVigilancia) return null;
    return new Date(Math.min(ahora.getTime() + 6 * HORA, finVigilancia));
  }
  return null;
}

/**
 * Consulta todo lo que el SII sabe del documento y lo guarda. Emite los webhooks de lo que cambió.
 *
 * Si un paso falla, lo que los pasos anteriores ya trajeron SE GUARDA antes de propagar el error:
 * una fecha de recepción obtenida no se pierde porque después falló la consulta de estado.
 */
export async function refrescarDocumento(c: Contribuyente, d: Documento, ahora = new Date()): Promise<Documento> {
  const sii = clienteSii();
  const ctx = contextoSii(c);
  const docSii = { rutEmisor: rutEmisorDe(c, d), tipoDoc: d.tipoDte, folio: d.folio };
  const data: Prisma.DocumentoUpdateInput & Partial<Pick<Documento, "fechaRecepcionSii" | "eventoReceptor" | "claseEstadoSii" | "estadoSii">> = {};

  try {
    if (TIPOS_REGISTRO_RECLAMO.has(d.tipoDte)) {
      const fecha = await sii.fechaRecepcion(ctx, docSii);
      if (fecha) {
        data.fechaRecepcionSii = new Date(fecha);
        data.plazoVence = vencimientoPlazo(fecha);
      }
      const ev = await sii.listarEventos(ctx, docSii);
      // 15 = listado; 16 = sin eventos. Cualquier otro código no dice nada sobre los eventos.
      if (ev.codigo === 15 || ev.codigo === 16) {
        data.eventosSii = ev.eventos as unknown as Prisma.InputJsonValue;
        data.eventosConsultadosEn = ahora;
        // El historial del SII manda; si no trae ninguno de los cinco, se conserva lo que dijo el RCV.
        data.eventoReceptor = eventoVigente(ev.eventos) ?? d.eventoReceptor;
      }
      const ced = await sii.consultarCedible(ctx, docSii);
      if (ced.cedibilidad !== "error" && ced.cedibilidad !== "desconocido") data.cedibilidad = ced.cedibilidad;
    }

    // El estado del DTE se pregunta por las COMPRAS: es la prueba de que el documento del proveedor existe.
    if (d.operacion === "COMPRA" && d.fechaEmision && d.montoTotal !== null) {
      const cert = await prisma.certificado.findUnique({ where: { contribuyenteId: c.id }, select: { rutTitular: true } });
      if (cert) {
        const e = await sii.estadoDte(ctx, {
          rutConsultante: cert.rutTitular,
          rutEmisor: d.rutContraparte,
          rutReceptor: c.rut,
          tipoDte: d.tipoDte,
          folio: d.folio,
          fechaEmision: d.fechaEmision.toISOString().slice(0, 10),
          // El RCV puede traer las notas de crédito en negativo; el SII las tiene por su monto.
          montoTotal: Math.abs(Number(d.montoTotal)),
        });
        data.estadoSii = e.estado;
        data.claseEstadoSii = e.clase;
        data.estadoSiiEn = ahora;
      }
    }
  } catch (e) {
    // Lo que dispara webhooks (evento, estado) NO se guarda a medias: la revisión siguiente lo
    // detecta como cambio y avisa. Lo demás sí, para no volver a pedirlo.
    const { eventoReceptor: _ev, estadoSii: _es, claseEstadoSii: _ce, estadoSiiEn: _en, ...parcial } = data;
    if (Object.keys(parcial).length > 0) await prisma.documento.update({ where: { id: d.id }, data: parcial });
    throw e;
  }

  const tentativo = { ...d, ...data } as Documento;
  const intentos = esperandoAlSii(tentativo) ? d.intentosRevision + 1 : 0;
  const agenda = { ...tentativo, intentosRevision: intentos };

  return prisma.$transaction(async (tx) => {
    const nuevo = await tx.documento.update({
      where: { id: d.id },
      data: { ...data, intentosRevision: intentos, erroresRevision: 0, errorRevision: null, proximaRevisionEn: proximaRevision(agenda, ahora) },
    });
    const pub = () => serializarDocumento(nuevo, { ahora, horasAviso: c.horasAvisoPlazo });
    if (nuevo.eventoReceptor && nuevo.eventoReceptor !== d.eventoReceptor) {
      await encolar(
        c.consumidorId,
        "documento.evento",
        `${nuevo.id}:${nuevo.eventoReceptor}`,
        { contribuyenteId: c.id, evento: nuevo.eventoReceptor, anterior: d.eventoReceptor, documento: pub() },
        tx,
      );
    }
    if (nuevo.claseEstadoSii && CLASES_ALERTA.has(nuevo.claseEstadoSii) && nuevo.claseEstadoSii !== d.claseEstadoSii) {
      await encolar(
        c.consumidorId,
        "documento.alerta",
        `estado:${nuevo.id}:${nuevo.estadoSii}`,
        { contribuyenteId: c.id, motivo: `estado_sii_${nuevo.claseEstadoSii}`, estadoSii: nuevo.estadoSii, documento: pub() },
        tx,
      );
    }
    return nuevo;
  });
}

/**
 * Revisa un lote de documentos vencidos. Los RECLAMA con un arriendo (`SKIP LOCKED`): dos procesos
 * con los jobs prendidos no le preguntan dos veces lo mismo al SII.
 */
export async function revisarPendientes(opts: { lote?: number; ahora?: Date } = {}): Promise<{ revisados: number; errores: number }> {
  const ahora = opts.ahora ?? new Date();
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE documentos SET proxima_revision_en = ${new Date(ahora.getTime() + ARRIENDO_MS)}
    WHERE id IN (
      SELECT d.id FROM documentos d
      JOIN contribuyentes c ON c.id = d.contribuyente_id
      JOIN certificados ce ON ce.contribuyente_id = c.id
      WHERE d.proxima_revision_en <= ${ahora} AND c.activo AND c.sincronizar_sii
      ORDER BY d.proxima_revision_en
      LIMIT ${opts.lote ?? 10}
      FOR UPDATE OF d SKIP LOCKED
    )
    RETURNING id`;
  let errores = 0;
  for (const { id } of ids) {
    const d = await prisma.documento.findUnique({ where: { id }, include: { contribuyente: true } });
    if (!d) continue;
    const { contribuyente, ...doc } = d;
    try {
      await refrescarDocumento(contribuyente, doc, ahora);
    } catch (e) {
      errores++;
      const fallas = doc.erroresRevision + 1;
      const detenido = fallas >= MAX_ERRORES_REVISION;
      // Un certificado que el SII no acepta no se arregla reintentando cada hora: espera 12 h.
      const espera = e instanceof ErrorSii && e.codigo === "SII_SIN_TOKEN" ? 12 * HORA : Math.min(HORA * 2 ** Math.min(fallas - 1, 5), DIA);
      const mensaje = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await prisma.$transaction(async (tx) => {
        const act = await tx.documento.update({
          where: { id },
          data: { erroresRevision: fallas, errorRevision: mensaje, proximaRevisionEn: detenido ? null : new Date(ahora.getTime() + espera) },
        });
        if (detenido) {
          // Detenerse en silencio sería perder el plazo de 8 días sin que nadie lo sepa.
          await encolar(
            contribuyente.consumidorId,
            "documento.alerta",
            `seguimiento-detenido:${id}:${ahora.toISOString().slice(0, 10)}`,
            {
              contribuyenteId: contribuyente.id,
              motivo: "seguimiento_detenido",
              error: mensaje,
              documento: serializarDocumento(act, { ahora, horasAviso: contribuyente.horasAvisoPlazo }),
            },
            tx,
          );
        }
      });
      log.warn("revisión de documento falló", { documento: id, fallas, detenido, error: e });
    }
  }
  return { revisados: ids.length, errores };
}

/**
 * Avisa los plazos por vencer y la aceptación tácita, cada uno UNA vez por documento (marcadores
 * `aviso_plazo_en` / `aviso_tacito_en`), los más urgentes primero.
 *
 * La tácita se declara sólo cuando ya no queda revisión pendiente contra el SII (la última corre 1 h
 * después del vencimiento): un evento registrado en las últimas horas no puede terminar avisado como
 * tácito. Si el contribuyente no tiene seguimiento (sin certificado o apagado), se avisa con lo que hay.
 * Sólo vencimientos de los últimos 3 días: importar un mes viejo no dispara cien avisos.
 */
export async function avisarPlazos(ahora = new Date()): Promise<number> {
  const porVencer = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT d.id FROM documentos d JOIN contribuyentes c ON c.id = d.contribuyente_id
    WHERE c.activo AND d.operacion = 'COMPRA' AND d.tipo_dte IN (33, 34, 43)
      AND d.evento_receptor IS NULL AND d.aviso_plazo_en IS NULL
      AND d.plazo_vence > ${ahora}
      AND d.plazo_vence <= ${ahora}::timestamptz + make_interval(hours => c.horas_aviso_plazo)
    ORDER BY d.plazo_vence
    LIMIT 500`;
  const vencidos = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT d.id FROM documentos d JOIN contribuyentes c ON c.id = d.contribuyente_id
    WHERE c.activo AND d.operacion = 'COMPRA' AND d.tipo_dte IN (33, 34, 43)
      AND d.evento_receptor IS NULL AND d.aviso_tacito_en IS NULL
      AND d.plazo_vence <= ${ahora} AND d.plazo_vence > ${new Date(ahora.getTime() - 3 * DIA)}
      AND (
        d.proxima_revision_en IS NULL
        OR NOT c.sincronizar_sii
        OR NOT EXISTS (SELECT 1 FROM certificados ce WHERE ce.contribuyente_id = c.id)
      )
    ORDER BY d.plazo_vence
    LIMIT 500`;
  let n = 0;
  for (const [lista, evento, marca] of [
    [porVencer, "documento.plazo_por_vencer", "avisoPlazoEn"],
    [vencidos, "documento.aceptado_tacito", "avisoTacitoEn"],
  ] as const) {
    for (const { id } of lista) {
      await prisma.$transaction(async (tx) => {
        const d = await tx.documento.findUnique({ where: { id }, include: { contribuyente: true } });
        if (!d) return;
        const { contribuyente: c, ...doc } = d;
        await encolar(c.consumidorId, evento, doc.id, { contribuyenteId: c.id, documento: serializarDocumento(doc, { ahora, horasAviso: c.horasAvisoPlazo }) }, tx);
        await tx.documento.update({ where: { id }, data: { [marca]: ahora } });
      });
      n++;
    }
  }
  return n;
}

/** Avisa los certificados que vencen en los próximos 30 días (a lo más una vez por semana). */
export async function avisarCertificados(ahora = new Date()): Promise<number> {
  const certs = await prisma.certificado.findMany({
    where: {
      validoHasta: { lte: new Date(ahora.getTime() + 30 * DIA) },
      OR: [{ avisoVencimientoEn: null }, { avisoVencimientoEn: { lt: new Date(ahora.getTime() - 7 * DIA) } }],
    },
    include: { contribuyente: true },
  });
  for (const cert of certs) {
    const dias = Math.floor((cert.validoHasta.getTime() - ahora.getTime()) / DIA);
    await prisma.$transaction(async (tx) => {
      await encolar(
        cert.contribuyente.consumidorId,
        "certificado.por_vencer",
        `${cert.huella}:${ahora.toISOString().slice(0, 10)}`,
        {
          contribuyenteId: cert.contribuyenteId,
          rut: cert.contribuyente.rut,
          rutTitular: cert.rutTitular,
          validoHasta: cert.validoHasta.toISOString(),
          diasParaVencer: dias,
          vencido: dias < 0,
        },
        tx,
      );
      await tx.certificado.update({ where: { id: cert.id }, data: { avisoVencimientoEn: ahora } });
    });
  }
  return certs.length;
}
