import { config } from "../config";
import { parsearEnvioDte, RecepcionInvalidaError, type DteRecibido } from "../core/dte-recepcion";
import { verificarDteRecibido } from "../core/dte-verificacion";
import { esFechaYmdValida } from "../core/fechas";
import { situacionPlazo } from "../core/plazos";
import { rutSii } from "../core/rut";
import { prisma } from "../db";
import { ErrorHttp, noEncontrado } from "../errores";
import type { Contribuyente, Documento, Operacion, Prisma } from "../generated/prisma/client";
import type { Actor } from "./consumidores";
import { contribuyenteDe } from "./contribuyentes";
import { encolar } from "./webhooks";

/** `tipo_dte` y `folio` son INTEGER: un número más grande no es un folio, es basura o un ataque. */
const INT4_MAX = 2_147_483_647;
const enRango = (n: number | null): n is number => n !== null && Number.isInteger(n) && n >= 1 && n <= INT4_MAX;

const big = (n: number | null | undefined) => (n === null || n === undefined ? null : BigInt(n));
const num = (n: bigint | null) => (n === null ? null : Number(n));
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** La forma pública de un documento. `conXml` agrega el XML crudo (puede pesar decenas de KB). */
export function serializarDocumento(d: Documento, opts: { ahora?: Date; horasAviso?: number; conXml?: boolean } = {}) {
  const ahora = opts.ahora ?? new Date();
  return {
    id: d.id,
    operacion: d.operacion,
    rutContraparte: d.rutContraparte,
    razonSocialContraparte: d.razonSocialContraparte,
    tipoDte: d.tipoDte,
    folio: d.folio,
    fechaEmision: ymd(d.fechaEmision),
    montoExento: num(d.montoExento),
    montoNeto: num(d.montoNeto),
    montoIva: num(d.montoIva),
    montoTotal: num(d.montoTotal),
    fuentes: { xml: d.enXml, rcv: d.enRcv },
    xml: d.enXml
      ? {
          sha256: d.xmlSha256,
          recibidoEn: iso(d.xmlRecibidoEn),
          verificacion: d.verificacion,
          ...(opts.conXml ? { contenido: d.xml, codificacion: d.codificacion } : {}),
        }
      : null,
    rcv: d.enRcv ? { estado: d.estadoRcv, periodo: d.periodoRcv, datos: d.datosRcv } : null,
    sii: {
      fechaRecepcion: iso(d.fechaRecepcionSii),
      eventoReceptor: d.eventoReceptor,
      eventos: d.eventosSii,
      eventosConsultadosEn: iso(d.eventosConsultadosEn),
      cedibilidad: d.cedibilidad,
      estado: d.estadoSii,
      claseEstado: d.claseEstadoSii,
      estadoConsultadoEn: iso(d.estadoSiiEn),
    },
    plazo:
      d.operacion === "COMPRA"
        ? situacionPlazo({
            tipoDte: d.tipoDte,
            fechaRecepcionSii: d.fechaRecepcionSii,
            fechaEmision: ymd(d.fechaEmision),
            evento: d.eventoReceptor,
            ahora,
            horasAviso: opts.horasAviso,
          })
        : null,
    seguimiento: {
      proximaRevisionEn: iso(d.proximaRevisionEn),
      intentos: d.intentosRevision,
      error: d.errorRevision,
    },
    creadoEn: d.creadoEn.toISOString(),
    actualizadoEn: d.actualizadoEn.toISOString(),
  };
}

/** El `SignatureValue` de la firma del documento (la única `<Signature>` dentro de un `<DTE>`). */
export function firmaDelDte(dteXml: string): string | null {
  const m = /<(?:[\w.-]+:)?SignatureValue>\s*([A-Za-z0-9+/=\s]+?)\s*<\/(?:[\w.-]+:)?SignatureValue>/.exec(dteXml);
  return m ? m[1]!.replace(/\s+/g, "") : null;
}

type Verificacion = { ok: boolean; problemas: string[]; sinLlaveSii: boolean };

export interface ResultadoIngreso {
  documentos: Array<{
    id: string;
    tipoDte: number;
    folio: number;
    rutEmisor: string;
    /**
     * nuevo: no existía · completado: existía por el RCV y ahora tiene XML · duplicado: el mismo XML ya
     * estaba · reemplazado: el guardado no verificaba y este sí · conflicto: otro XML para el folio, se
     * conservó el guardado.
     */
    resultado: "nuevo" | "completado" | "duplicado" | "reemplazado" | "conflicto";
    verificacion: Verificacion;
  }>;
  problemas: string[];
}

/**
 * Cuánto se le cree a un XML, de más a menos: verificó TODO (incluida la FRMA del CAF contra la llave
 * del SII) > sin fallas pero sin la llave del SII > con fallas. Un XML nunca le gana a otro que se le
 * cree más: la casilla de intercambio es pública y cualquiera puede mandar un DTE con un CAF inventado
 * y el folio siguiente de un proveedor real.
 */
export function confianza(v: Verificacion): number {
  if (v.ok) return 2;
  return v.problemas.length === 0 ? 1 : 0;
}

/**
 * Ingresa DTE RECIBIDOS (compras) ya separados por `parsearEnvioDte`. Verifica la criptografía de
 * cada uno (firma, timbre, CAF) y lo guarda tal como llegó. Un DTE que no es para este receptor no
 * se guarda: se informa.
 *
 * Mismo folio con OTRO XML: un folio no se reemite, así que es un error del proveedor o un intento de
 * suplantación. Gana el XML al que se le cree MÁS (`confianza`); a igual confianza, el primero. Las dos
 * situaciones alertan. Un XML con fallas tampoco pisa los montos que registró el SII (RCV).
 */
export async function ingresarDtes(c: Contribuyente, dtes: DteRecibido[], ahora = new Date()): Promise<ResultadoIngreso> {
  const out: ResultadoIngreso = { documentos: [], problemas: [] };
  for (const d of dtes) {
    const ident = `tipo ${d.tipoDte ?? "?"} folio ${d.folio ?? "?"} de ${d.rutEmisor}`;
    if (!enRango(d.tipoDte) || !enRango(d.folio) || !rutSii(d.rutEmisor)) {
      out.problemas.push(`DTE sin tipo/folio válidos o con RUT emisor inválido (${ident})${d.problemas.length ? `: ${d.problemas.join("; ")}` : ""}`);
      continue;
    }
    if (rutSii(d.rutRecep) !== c.rut) {
      out.problemas.push(`${ident}: es para el receptor ${d.rutRecep}, no para ${c.rut}; no se guardó`);
      continue;
    }
    const verificacion = verificarDteRecibido(d, { ambiente: c.ambiente, llavesSii: config().llavesSii });
    const valido = d as DteRecibido & { tipoDte: number; folio: number };
    // Dos ingresos simultáneos del mismo folio: el segundo choca con la unicidad y se reintenta UNA
    // vez, ya viendo el documento del primero.
    let r: { doc: Documento; resultado: ResultadoIngreso["documentos"][number]["resultado"]; problema?: string };
    try {
      r = await ingresarUno(c, valido, verificacion, ahora);
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
      r = await ingresarUno(c, valido, verificacion, ahora);
    }
    if (r.problema) out.problemas.push(`${ident}: ${r.problema}`);
    out.documentos.push({ id: r.doc.id, tipoDte: d.tipoDte, folio: d.folio, rutEmisor: d.rutEmisor, resultado: r.resultado, verificacion });
  }
  return out;
}

async function ingresarUno(c: Contribuyente, d: DteRecibido & { tipoDte: number; folio: number }, verificacion: Verificacion, ahora: Date) {
  const clave = { contribuyenteId: c.id, operacion: "COMPRA" as Operacion, rutContraparte: d.rutEmisor, tipoDte: d.tipoDte, folio: d.folio };
  const datosXml = {
    enXml: true,
    xml: d.xml,
    xmlSha256: d.sha256,
    codificacion: d.codificacion,
    firmaDte: firmaDelDte(d.xml),
    verificacion: verificacion as unknown as Prisma.InputJsonValue,
    xmlRecibidoEn: ahora,
  };
  const datosDoc = {
    razonSocialContraparte: d.rznSoc,
    fechaEmision: d.fchEmis && esFechaYmdValida(d.fchEmis) ? new Date(`${d.fchEmis}T00:00:00Z`) : null,
    montoExento: big(d.mntExe),
    montoNeto: big(d.mntNeto),
    montoIva: big(d.iva),
    montoTotal: big(d.mntTotal),
  };
  const conf = confianza(verificacion);

  return prisma.$transaction(async (tx) => {
    const existente = await tx.documento.findUnique({ where: { contribuyenteId_operacion_rutContraparte_tipoDte_folio: clave } });
    let doc: Documento;
    let resultado: ResultadoIngreso["documentos"][number]["resultado"];
    let problema: string | undefined;

    if (!existente) {
      doc = await tx.documento.create({ data: { ...clave, ...datosDoc, ...datosXml, proximaRevisionEn: c.sincronizarSii ? ahora : null } });
      resultado = "nuevo";
    } else if (!existente.enXml) {
      // Ya estaba por el RCV: el XML lo completa. Los montos firmados mandan… sólo si el XML no falla.
      doc = await tx.documento.update({
        where: { id: existente.id },
        data: { ...(conf >= 1 ? datosDoc : {}), ...datosXml, proximaRevisionEn: c.sincronizarSii ? ahora : existente.proximaRevisionEn },
      });
      resultado = "completado";
      if (conf === 0) problema = "el XML no verifica: se guardó, pero se conservaron los montos registrados en el SII";
    } else if (existente.xmlSha256 === d.sha256) {
      doc = existente;
      resultado = "duplicado";
    } else if (conf > confianza(existente.verificacion as unknown as Verificacion)) {
      doc = await tx.documento.update({ where: { id: existente.id }, data: { ...datosDoc, ...datosXml } });
      resultado = "reemplazado";
      problema = "llegó otro XML para el folio y verifica mejor que el guardado: lo reemplazó";
    } else {
      doc = existente;
      resultado = "conflicto";
      problema = "llegó un XML DISTINTO para un folio que ya estaba; se conservó el guardado";
    }

    const pub = serializarDocumento(doc, { ahora, horasAviso: c.horasAvisoPlazo });
    if (resultado === "reemplazado" || resultado === "conflicto") {
      await encolar(
        c.consumidorId,
        "documento.alerta",
        `xml-distinto:${doc.id}:${d.sha256}`,
        { contribuyenteId: c.id, motivo: "xml_distinto_mismo_folio", resultado, sha256Nuevo: d.sha256, verificacionNuevo: verificacion, documento: pub },
        tx,
      );
    }
    if (resultado === "nuevo" || resultado === "completado") {
      await encolar(c.consumidorId, "documento.recibido", doc.id, { contribuyenteId: c.id, documento: pub }, tx);
      // Sin la llave del SII configurada la FRMA queda sin probar: eso no es una falla del documento.
      if (verificacion.problemas.length > 0) {
        await encolar(
          c.consumidorId,
          "documento.alerta",
          `verificacion:${doc.id}`,
          { contribuyenteId: c.id, motivo: "verificacion_fallida", problemas: verificacion.problemas, documento: pub },
          tx,
        );
      }
    }
    return { doc, resultado, problema };
  });
}

/** Subida directa de un `<EnvioDTE>` o un `<DTE>` suelto. */
export async function ingresarXml(actor: Actor, contribuyenteId: string, bytes: Buffer): Promise<ResultadoIngreso> {
  const c = await contribuyenteDe(actor, contribuyenteId);
  let envio;
  try {
    envio = parsearEnvioDte(bytes, { maxDtes: 500 });
  } catch (e) {
    if (e instanceof RecepcionInvalidaError) throw new ErrorHttp(400, `XML_${e.codigo}`, e.message);
    throw new ErrorHttp(400, "XML_ILEGIBLE", e instanceof Error ? e.message : String(e));
  }
  const r = await ingresarDtes(c, envio.dtes);
  if (envio.truncado) r.problemas.push("el sobre trae más de 500 DTE: se leyeron los primeros 500");
  return r;
}

export interface FiltroDocumentos {
  operacion?: Operacion;
  periodo?: string;
  desde?: string;
  hasta?: string;
  tipoDte?: number;
  rutContraparte?: string;
  /** Sólo los que esperan una decisión: compras 33/34/43 sin evento y con plazo vigente o sin fecha. */
  pendientes?: boolean;
  soloRcv?: boolean;
  soloXml?: boolean;
  limite?: number;
  cursor?: string;
}

export async function listarDocumentos(actor: Actor, contribuyenteId: string, f: FiltroDocumentos, ahora = new Date()) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  const where: Prisma.DocumentoWhereInput = { contribuyenteId: c.id };
  if (f.operacion) where.operacion = f.operacion;
  if (f.tipoDte) where.tipoDte = f.tipoDte;
  if (f.rutContraparte) where.rutContraparte = rutSii(f.rutContraparte) || f.rutContraparte;
  if (f.periodo) where.periodoRcv = f.periodo;
  if (f.desde || f.hasta) {
    where.fechaEmision = {
      ...(f.desde ? { gte: new Date(`${f.desde}T00:00:00Z`) } : {}),
      ...(f.hasta ? { lte: new Date(`${f.hasta}T00:00:00Z`) } : {}),
    };
  }
  if (f.soloRcv) Object.assign(where, { enRcv: true, enXml: false });
  if (f.soloXml) Object.assign(where, { enXml: true, enRcv: false });
  if (f.pendientes) {
    Object.assign(where, {
      operacion: "COMPRA",
      tipoDte: { in: [33, 34, 43] },
      eventoReceptor: null,
      OR: [{ plazoVence: null }, { plazoVence: { gt: ahora } }],
    });
  }
  const limite = Math.min(Math.max(f.limite ?? 100, 1), 500);
  const filas = await prisma.documento.findMany({
    where,
    orderBy: [{ creadoEn: "desc" }, { id: "desc" }],
    take: limite + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
  });
  const hayMas = filas.length > limite;
  const pagina = filas.slice(0, limite);
  return {
    documentos: pagina.map((d) => serializarDocumento(d, { ahora, horasAviso: c.horasAvisoPlazo })),
    siguienteCursor: hayMas ? pagina.at(-1)!.id : null,
  };
}

export async function documentoDe(actor: Actor, contribuyenteId: string, documentoId: string): Promise<{ c: Contribuyente; d: Documento }> {
  const c = await contribuyenteDe(actor, contribuyenteId);
  if (!/^[0-9a-f-]{36}$/i.test(documentoId)) throw noEncontrado("El documento");
  const d = await prisma.documento.findFirst({ where: { id: documentoId, contribuyenteId: c.id } });
  if (!d) throw noEncontrado("El documento");
  return { c, d };
}
