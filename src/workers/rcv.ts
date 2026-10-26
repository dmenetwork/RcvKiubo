import { createHash } from "node:crypto";
import { cruzar, type DocumentoCruzable } from "../core/cruce";
import { esPeriodo } from "../core/fechas";
import { EVENTO_RCV_ACUSE, EVENTO_RCV_RECLAMADO, vencimientoPlazo } from "../core/plazos";
import { ESTADOS_RCV, metadatosDeNombre, parsearRcvCsv, type EstadoRcv, type FilaRcv, type OperacionRcv } from "../core/rcv-csv";
import { rutSii } from "../core/rut";
import { prisma, type Tx } from "../db";
import { ErrorHttp } from "../errores";
import type { Documento, Prisma } from "../generated/prisma/client";
import type { Actor } from "./consumidores";
import { contribuyenteDe } from "./contribuyentes";
import { serializarDocumento } from "./documentos";
import { encolar } from "./webhooks";

/**
 * Import del CSV del Registro de Compras y Ventas y los cruces que lo hacen útil.
 *
 * El CSV lo baja una persona del portal (el portal exige reCAPTCHA desde 2024; ver README). Una vez
 * acá, cada fila es un documento por su identidad (contraparte, tipo, folio): si ya existía por el
 * XML se completa con lo que dice el SII; si no, queda como documento "sólo en RCV" — exactamente las
 * facturas que nunca llegaron al buzón.
 */

const big = (n: number | null) => (n === null ? null : BigInt(n));

export interface OpcionesImport {
  operacion?: OperacionRcv;
  periodo?: string;
  estado?: EstadoRcv;
  nombreArchivo?: string;
}

export async function importarCsv(actor: Actor, contribuyenteId: string, bytes: Buffer, opts: OpcionesImport, ahora = new Date()) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  const meta = opts.nombreArchivo ? metadatosDeNombre(opts.nombreArchivo) : null;
  if (meta?.rut && meta.rut !== c.rut) {
    throw new ErrorHttp(422, "RCV_DE_OTRO_RUT", `El archivo es del RUT ${meta.rut} y el contribuyente es ${c.rut}.`);
  }

  let leido;
  try {
    leido = parsearRcvCsv(bytes, { operacion: opts.operacion ?? meta?.operacion ?? undefined });
  } catch (e) {
    throw new ErrorHttp(400, "RCV_ILEGIBLE", e instanceof Error ? e.message : String(e));
  }
  const operacion = leido.operacion;
  if (!operacion) throw new ErrorHttp(400, "RCV_SIN_OPERACION", "No se pudo saber si el archivo es de compras o de ventas: indica `operacion`.");
  const periodo = opts.periodo ?? meta?.periodo ?? null;
  if (!periodo || !esPeriodo(periodo)) {
    throw new ErrorHttp(400, "RCV_SIN_PERIODO", "Indica el período tributario (`periodo` AAAAMM): el CSV no lo trae y el nombre del archivo tampoco.");
  }
  // Sin estado explícito, compras va a REGISTRO (el detalle por defecto del portal); ventas no tiene estados.
  const estado = opts.estado ?? meta?.estado ?? (operacion === "COMPRA" ? "REGISTRO" : null);
  if (estado && !ESTADOS_RCV.includes(estado)) throw new ErrorHttp(400, "RCV_ESTADO_INVALIDO", `Estado desconocido: ${estado}`);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const previa = await prisma.importacionRcv.findUnique({ where: { contribuyenteId_sha256: { contribuyenteId: c.id, sha256 } } });
  if (previa) return { importacion: previa, yaImportado: true, faltantesXml: [] as unknown[] };

  // Todo o nada: un archivo a medio importar no deja documentos sin su `ImportacionRcv`. Dos imports
  // simultáneos del mismo archivo chocan en la unicidad (contribuyente, sha256) y el segundo devuelve
  // el primero.
  let resultado;
  try {
    resultado = await prisma.$transaction(
      async (tx) => {
        let nuevos = 0;
        let actualizados = 0;
        for (const f of leido.filas) {
          if ((await upsertFila(tx, c.id, operacion, periodo, estado, f)).nuevo) nuevos++;
          else actualizados++;
        }
        const importacion = await tx.importacionRcv.create({
          data: {
            contribuyenteId: c.id,
            operacion,
            estadoRcv: estado,
            periodo,
            nombreArchivo: opts.nombreArchivo ?? null,
            sha256,
            filas: leido.filas.length,
            nuevos,
            actualizados,
            problemas: leido.problemas as unknown as Prisma.InputJsonValue,
            columnasDesconocidas: leido.columnasDesconocidas,
          },
        });
        // Lo accionable: lo que el SII tiene y el buzón no trajo.
        const faltantes =
          operacion === "COMPRA"
            ? await tx.documento.findMany({
                where: { contribuyenteId: c.id, operacion, periodoRcv: periodo, enRcv: true, enXml: false },
                orderBy: [{ rutContraparte: "asc" }, { folio: "asc" }],
                take: 1000,
              })
            : [];
        const faltantesXml = faltantes.map((d) => serializarDocumento(d, { ahora, horasAviso: c.horasAvisoPlazo }));
        await encolar(
          c.consumidorId,
          "rcv.importado",
          importacion.id,
          { contribuyenteId: c.id, operacion, periodo, estado, filas: leido.filas.length, nuevos, actualizados, problemas: leido.problemas.length, faltantesXml },
          tx,
        );
        return { importacion, yaImportado: false, faltantesXml };
      },
      { timeout: 5 * 60_000, maxWait: 30_000 },
    );
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    const ganadora = await prisma.importacionRcv.findUniqueOrThrow({ where: { contribuyenteId_sha256: { contribuyenteId: c.id, sha256 } } });
    return { importacion: ganadora, yaImportado: true, faltantesXml: [] as unknown[] };
  }
  return resultado;
}

/**
 * Una fila del RCV (CSV o portal) → documento. Un documento NUEVO que sólo se conoce por el RCV no se
 * agenda para el seguimiento del WS: el propio RCV ya trae su recepción, acuse y reclamo, y la
 * sincronización lo mantiene al día.
 */
export async function upsertFila(
  db: Tx,
  contribuyenteId: string,
  operacion: OperacionRcv,
  periodo: string,
  estado: string | null,
  f: FilaRcv,
): Promise<{ id: string; nuevo: boolean }> {
  const clave = { contribuyenteId, operacion, rutContraparte: f.rutContraparte, tipoDte: f.tipoDte, folio: f.folio };
  // El RCV dice QUE hubo reclamo o acuse, no cuál de los cinco eventos: queda un marcador que el
  // historial del SII reemplaza por el código exacto (ver `core/plazos.ts`). Sin esto, un documento
  // reclamado seguiría avisando "plazo por vencer".
  const eventoRcv = estado === "RECLAMADO" || f.fechaReclamo ? EVENTO_RCV_RECLAMADO : f.fechaAcuse ? EVENTO_RCV_ACUSE : null;
  const datosRcv = {
    enRcv: true,
    estadoRcv: estado,
    periodoRcv: periodo,
    datosRcv: { ...f, linea: undefined } as unknown as Prisma.InputJsonValue,
    ...(f.fechaRecepcionSii ? { fechaRecepcionSii: new Date(f.fechaRecepcionSii), plazoVence: vencimientoPlazo(f.fechaRecepcionSii) } : {}),
  };
  const existente = await db.documento.findUnique({ where: { contribuyenteId_operacion_rutContraparte_tipoDte_folio: clave } });
  if (existente) {
    // Lo firmado (XML) manda sobre los montos; el RCV sólo llena lo que falta.
    const relleno: Prisma.DocumentoUpdateInput = existente.enXml
      ? {}
      : {
          razonSocialContraparte: f.razonSocial,
          fechaEmision: f.fechaEmision ? new Date(`${f.fechaEmision}T00:00:00Z`) : null,
          montoExento: big(f.montoExento),
          montoNeto: big(f.montoNeto),
          montoIva: big(f.montoIva),
          montoTotal: big(f.montoTotal),
        };
    await db.documento.update({
      where: { id: existente.id },
      data: { ...relleno, ...datosRcv, ...(eventoRcv && !existente.eventoReceptor ? { eventoReceptor: eventoRcv } : {}) },
    });
    return { id: existente.id, nuevo: false };
  }
  const d = await db.documento.create({
    data: {
      ...clave,
      ...datosRcv,
      eventoReceptor: eventoRcv,
      razonSocialContraparte: f.razonSocial,
      fechaEmision: f.fechaEmision ? new Date(`${f.fechaEmision}T00:00:00Z`) : null,
      montoExento: big(f.montoExento),
      montoNeto: big(f.montoNeto),
      montoIva: big(f.montoIva),
      montoTotal: big(f.montoTotal),
    },
  });
  return { id: d.id, nuevo: true };
}

export async function listarImportaciones(actor: Actor, contribuyenteId: string) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  return prisma.importacionRcv.findMany({ where: { contribuyenteId: c.id }, orderBy: { creadoEn: "desc" }, take: 200 });
}

const cruzable = (d: Documento): DocumentoCruzable & { id: string } => ({
  id: d.id,
  rutContraparte: d.rutContraparte,
  tipoDte: d.tipoDte,
  folio: d.folio,
  montoTotal: d.montoTotal === null ? null : Number(d.montoTotal),
  fechaEmision: d.fechaEmision ? d.fechaEmision.toISOString().slice(0, 10) : null,
});

/**
 * Cruce interno de un período: lo que dice el RCV contra lo que llegó por XML.
 *
 * - `faltaXml`: el SII lo tiene y el buzón no — reclamarle el XML al proveedor (o no se puede usar
 *   el crédito con respaldo).
 * - `faltaEnRcv`: llegó el XML y el RCV del período no lo tiene — otro período, pendiente, o aún no
 *   registrado.
 * - `montoDistinto`: el monto del XML firmado no es el que registró el SII.
 */
export async function cruceRcv(actor: Actor, contribuyenteId: string, periodo: string, operacion: OperacionRcv = "COMPRA") {
  const c = await contribuyenteDe(actor, contribuyenteId);
  if (!esPeriodo(periodo)) throw new ErrorHttp(400, "PERIODO_INVALIDO", "El período va como AAAAMM.");
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(4));
  const desde = new Date(Date.UTC(anio, mes - 1, 1));
  const hasta = new Date(Date.UTC(anio, mes, 1));
  const docs = await prisma.documento.findMany({
    where: {
      contribuyenteId: c.id,
      operacion,
      OR: [{ periodoRcv: periodo }, { enRcv: false, fechaEmision: { gte: desde, lt: hasta } }],
    },
  });
  const ser = (d: Documento) => serializarDocumento(d, { horasAviso: c.horasAvisoPlazo });
  const montoDistinto = docs.filter((d) => {
    if (!d.enXml || !d.enRcv) return false;
    const rcvTotal = (d.datosRcv as { montoTotal?: number | null } | null)?.montoTotal;
    return rcvTotal != null && d.montoTotal !== null && Number(d.montoTotal) !== rcvTotal;
  });
  return {
    periodo,
    operacion,
    totales: {
      documentos: docs.length,
      enAmbos: docs.filter((d) => d.enXml && d.enRcv).length,
      faltaXml: docs.filter((d) => d.enRcv && !d.enXml).length,
      faltaEnRcv: docs.filter((d) => d.enXml && !d.enRcv).length,
      montoDistinto: montoDistinto.length,
    },
    faltaXml: docs.filter((d) => d.enRcv && !d.enXml).map(ser),
    faltaEnRcv: docs.filter((d) => d.enXml && !d.enRcv).map(ser),
    montoDistinto: montoDistinto.map((d) => ({ ...ser(d), montoRcv: (d.datosRcv as { montoTotal?: number }).montoTotal })),
  };
}

export interface DocumentoDelConsumidor {
  rutContraparte: string;
  tipoDte: number;
  folio: number;
  montoTotal?: number | null;
  fechaEmision?: string | null;
  referencia?: string | null;
}

/**
 * Cruce contra la lista del CONSUMIDOR (p. ej. las facturas de compra que Kiubo tiene registradas).
 * El servicio aporta todo lo que sabe del período —XML y RCV— y devuelve las tres diferencias.
 */
export async function cruceConConsumidor(
  actor: Actor,
  contribuyenteId: string,
  p: { operacion: OperacionRcv; periodo?: string; desde?: string; hasta?: string; documentos: DocumentoDelConsumidor[] },
) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  const where: Prisma.DocumentoWhereInput = { contribuyenteId: c.id, operacion: p.operacion };
  if (p.periodo) {
    if (!esPeriodo(p.periodo)) throw new ErrorHttp(400, "PERIODO_INVALIDO", "El período va como AAAAMM.");
    where.periodoRcv = p.periodo;
  } else if (p.desde || p.hasta) {
    where.fechaEmision = {
      ...(p.desde ? { gte: new Date(`${p.desde}T00:00:00Z`) } : {}),
      ...(p.hasta ? { lte: new Date(`${p.hasta}T00:00:00Z`) } : {}),
    };
  } else {
    throw new ErrorHttp(400, "CRUCE_SIN_RANGO", "Indica `periodo` (AAAAMM) o `desde`/`hasta`: cruzar contra todo el historial no sirve.");
  }
  const propios = p.documentos.map((d) => {
    const rut = rutSii(d.rutContraparte);
    if (!rut) throw new ErrorHttp(400, "RUT_INVALIDO", `RUT inválido en la lista: ${d.rutContraparte}`);
    return { ...d, rutContraparte: rut };
  });
  const delServicio = (await prisma.documento.findMany({ where })).map(cruzable);
  const r = cruzar(delServicio, propios);
  return {
    totales: {
      servicio: delServicio.length,
      consumidor: propios.length,
      coinciden: r.coinciden,
      faltanEnConsumidor: r.soloEnA.length,
      faltanEnServicio: r.soloEnB.length,
      diferencias: r.diferencias.length,
    },
    faltanEnConsumidor: r.soloEnA,
    faltanEnServicio: r.soloEnB,
    diferencias: r.diferencias.map((x) => ({ servicio: x.a, consumidor: x.b, campos: x.campos })),
    duplicadosEnLista: r.duplicadosB,
  };
}

/** Resumen de un período por tipo de documento y por situación del plazo. */
export async function resumenPeriodo(actor: Actor, contribuyenteId: string, periodo: string, ahora = new Date()) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  if (!esPeriodo(periodo)) throw new ErrorHttp(400, "PERIODO_INVALIDO", "El período va como AAAAMM.");
  const docs = await prisma.documento.findMany({ where: { contribuyenteId: c.id, periodoRcv: periodo } });
  const porTipo: Record<string, { documentos: number; montoNeto: number; montoIva: number; montoTotal: number }> = {};
  const porPlazo: Record<string, number> = {};
  for (const d of docs) {
    const k = `${d.operacion}:${d.tipoDte}`;
    const t = (porTipo[k] ??= { documentos: 0, montoNeto: 0, montoIva: 0, montoTotal: 0 });
    t.documentos++;
    t.montoNeto += Number(d.montoNeto ?? 0n);
    t.montoIva += Number(d.montoIva ?? 0n);
    t.montoTotal += Number(d.montoTotal ?? 0n);
    const plazo = serializarDocumento(d, { ahora, horasAviso: c.horasAvisoPlazo }).plazo;
    if (plazo) porPlazo[plazo.estado] = (porPlazo[plazo.estado] ?? 0) + 1;
  }
  return { periodo, porTipo, porPlazo, documentos: docs.length };
}
