import { randomUUID } from "node:crypto";
import { parsearFechaChilena } from "./fechas";
import type { EstadoRcv, FilaRcv, OperacionRcv } from "./rcv-csv";
import { rutSii } from "./rut";

/**
 * El Registro de Compras y Ventas tal como lo sirve el portal del SII (`consdcvinternetui`): los
 * servicios JSON (`facadeService`) que usa la propia pantalla del RCV. Dominio puro: arma los
 * cuerpos y lee las respuestas; la red y el login con certificado viven en `sii/portal.ts`.
 *
 * ## Probado en vivo
 *
 * El 2026-10-26, con la sesión de MiSII del certificado de Jorge (11.598.736-4), producción:
 * `getResumen` (compras en los cuatro estados, ventas) y `getDetalleCompra` / `getDetalleVenta`
 * respondieron `codRespuesta 0` SIN reCAPTCHA (426 facturas de compra registradas, 71 pendientes,
 * 381 de venta en octubre). Los nombres de campo y los formatos de abajo son los de esa respuesta.
 *
 * ## Captcha: falla cerrado
 *
 * Comentarios de terceros de 2024 dicen que el SII agregó reCAPTCHA a estas consultas. Con sesión de
 * certificado no lo pidió. Si algún día lo pide, `respuestaPideCaptcha` lo detecta y la
 * sincronización se DETIENE y avisa: este servicio nunca manda ni fabrica un token de captcha.
 */

export const BASE_RCV = "https://www4.sii.cl/consdcvinternetui";
export const URL_FACADE = `${BASE_RCV}/services/data/facadeService`;
const NAMESPACE = "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService";

export type MetodoRcv = "getResumen" | "getDetalleCompra" | "getDetalleVenta";

export function partirRut(rut: string): { cuerpo: string; dv: string } {
  const r = rutSii(rut);
  if (!r) throw new Error(`RUT inválido: ${rut}`);
  const [cuerpo, dv] = r.split("-") as [string, string];
  return { cuerpo, dv };
}

/** El cuerpo de una consulta: `metaData` con el TOKEN de la sesión como `conversationId`. */
export function cuerpoRcv(metodo: MetodoRcv, token: string, data: Record<string, unknown>): string {
  return JSON.stringify({
    metaData: { namespace: `${NAMESPACE}/${metodo}`, conversationId: token, transactionId: randomUUID(), page: null },
    data,
  });
}

export function datosResumen(rutEmpresa: string, periodo: string, operacion: OperacionRcv, estado: EstadoRcv): Record<string, unknown> {
  const { cuerpo, dv } = partirRut(rutEmpresa);
  return { rutEmisor: cuerpo, dvEmisor: dv, ptributario: periodo, estadoContab: estado, operacion, busquedaInicial: true };
}

export function datosDetalle(rutEmpresa: string, periodo: string, operacion: OperacionRcv, estado: EstadoRcv | "", tipoDte: number): Record<string, unknown> {
  const { cuerpo, dv } = partirRut(rutEmpresa);
  return { rutEmisor: cuerpo, dvEmisor: dv, ptributario: periodo, codTipoDoc: tipoDte, operacion, estadoContab: estado };
}

/** ¿El SII pide captcha? Cualquier mención basta para detenerse. */
export function respuestaPideCaptcha(texto: string): boolean {
  return /captcha/i.test(texto);
}

export interface RespuestaRcv<T> {
  codigo: number;
  mensaje: string | null;
  filas: T[];
}

/**
 * Lee `{ data, respEstado }`. `codRespuesta` 0 = OK. 99 con "no hay documentos o debe ser de forma
 * diferida" es la respuesta normal para un tipo sin detalle (boletas) o sin documentos: lista vacía.
 * Cualquier otra cosa es error, nunca "vacío".
 */
export function parsearRespuestaRcv<T>(texto: string): RespuestaRcv<T> {
  let j: { data?: unknown; respEstado?: { codRespuesta?: number; msgeRespuesta?: string | null } };
  try {
    j = JSON.parse(texto);
  } catch {
    throw new Error(`El portal del RCV no devolvió JSON: ${texto.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);
  }
  const codigo = j.respEstado?.codRespuesta;
  if (typeof codigo !== "number") throw new Error("El portal del RCV no devolvió respEstado.");
  const mensaje = j.respEstado?.msgeRespuesta ?? null;
  if (codigo === 0) return { codigo, mensaje, filas: Array.isArray(j.data) ? (j.data as T[]) : [] };
  if (codigo === 99 && /no hay documentos|diferida/i.test(mensaje ?? "")) return { codigo, mensaje, filas: [] };
  throw new Error(`El portal del RCV respondió ${codigo}: ${mensaje ?? "(sin mensaje)"}`);
}

// ── Resumen ───────────────────────────────────────────────────────────────────────────────────

export interface FilaResumenSii {
  rsmnTipoDocInteger: number;
  dcvNombreTipoDoc: string;
  /** `DET_ELE` = tiene detalle electrónico; `RESUMEN` = sólo totales (boletas). */
  dcvTipoIngresoDoc: string;
  rsmnLink: boolean;
  rsmnTotDoc: number;
  rsmnMntExe: number;
  rsmnMntNeto: number;
  rsmnMntIVA: number;
  rsmnMntIVANoRec: number;
  rsmnIVAUsoComun: number;
  rsmnMntTotal: number;
}

export interface ResumenRcv {
  tipoDte: number;
  nombreTipoDoc: string;
  tipoIngreso: string;
  tieneDetalle: boolean;
  totalDocumentos: number;
  montoExento: number;
  montoNeto: number;
  montoIva: number;
  montoIvaNoRecuperable: number;
  ivaUsoComun: number;
  montoTotal: number;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function normalizarResumen(f: FilaResumenSii): ResumenRcv {
  return {
    tipoDte: f.rsmnTipoDocInteger,
    nombreTipoDoc: f.dcvNombreTipoDoc,
    tipoIngreso: f.dcvTipoIngresoDoc,
    tieneDetalle: f.rsmnLink === true && f.dcvTipoIngresoDoc !== "RESUMEN",
    totalDocumentos: n(f.rsmnTotDoc),
    montoExento: n(f.rsmnMntExe),
    montoNeto: n(f.rsmnMntNeto),
    montoIva: n(f.rsmnMntIVA),
    montoIvaNoRecuperable: n(f.rsmnMntIVANoRec),
    ivaUsoComun: n(f.rsmnIVAUsoComun),
    montoTotal: n(f.rsmnMntTotal),
  };
}

// ── Detalle ───────────────────────────────────────────────────────────────────────────────────

/** Los campos del detalle que se mapean; el resto viaja en `extra`. */
export interface FilaDetalleSii {
  detTipoDoc: number | null;
  detRutDoc: number | string | null;
  detDvDoc: string | null;
  detRznSoc: string | null;
  detNroDoc: number | null;
  detFchDoc: string | null;
  detFecAcuse: string | null;
  detFecReclamado: string | null;
  detFecRecepcion: string | null;
  detMntExe: number | null;
  detMntNeto: number | null;
  detMntIVA: number | null;
  detMntIVANoRec: number | null;
  detMntCodNoRec: number | null;
  detMntTotal: number | null;
  totalDtoiMontoImp: number | null;
  descTipoTransaccion: string | null;
  detEventoReceptor: string | null;
  detEventoReceptorLeyenda: string | null;
  detTipoDocRef: number | null;
  detFolioDocRef: string | number | null;
  [campo: string]: unknown;
}

const MAPEADOS = new Set([
  "detTipoDoc", "detRutDoc", "detDvDoc", "detRznSoc", "detNroDoc", "detFchDoc", "detFecAcuse", "detFecReclamado",
  "detFecRecepcion", "detMntExe", "detMntNeto", "detMntIVA", "detMntIVANoRec", "detMntCodNoRec", "detMntTotal",
  "descTipoTransaccion",
]);
/** Identificadores internos del SII, sin valor para nadie fuera del portal. */
const INTERNOS = new Set(["dhdrCodigo", "dcvCodigo", "detCodigo", "cambiarTipoTran", "emisorAgresivo"]);

const ent = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/**
 * Una fila del detalle del portal en la MISMA forma que una fila del CSV (`FilaRcv`): así el portal y
 * el CSV entran por el mismo upsert. `tipoDte` viene del pedido (en compras el SII deja `detTipoDoc`
 * en null). Devuelve el motivo si la fila no se puede usar.
 */
export function filaDesdePortal(f: FilaDetalleSii, tipoDte: number, linea: number): FilaRcv | string {
  const rut = rutSii(`${f.detRutDoc ?? ""}-${f.detDvDoc ?? ""}`);
  const folio = ent(f.detNroDoc);
  if (!rut) return `RUT inválido: ${f.detRutDoc}-${f.detDvDoc}`;
  if (folio === null || folio < 1 || folio > 2_147_483_647) return `folio inválido: ${f.detNroDoc}`;
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (MAPEADOS.has(k) || INTERNOS.has(k) || v === null || v === undefined || v === "" || v === 0) continue;
    extra[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return {
    linea,
    tipoDte: ent(f.detTipoDoc) ?? tipoDte,
    rutContraparte: rut,
    razonSocial: f.detRznSoc || null,
    folio,
    fechaEmision: parsearFechaChilena(f.detFchDoc)?.slice(0, 10) ?? null,
    fechaRecepcionSii: parsearFechaChilena(f.detFecRecepcion),
    fechaAcuse: parsearFechaChilena(f.detFecAcuse),
    fechaReclamo: parsearFechaChilena(f.detFecReclamado),
    tipoTransaccion: f.descTipoTransaccion || null,
    montoExento: ent(f.detMntExe),
    montoNeto: ent(f.detMntNeto),
    montoIva: ent(f.detMntIVA),
    montoIvaNoRecuperable: ent(f.detMntIVANoRec),
    codigoIvaNoRecuperable: ent(f.detMntCodNoRec) || null,
    montoTotal: ent(f.detMntTotal),
    // El detalle trae el TOTAL de otros impuestos (`totalDtoiMontoImp`, queda en `extra`), no el
    // desglose por código: inventar un código para ese total sería peor que no tenerlo.
    otrosImpuestos: [],
    extra,
  };
}

export const ESTADOS_COMPRA: readonly EstadoRcv[] = ["REGISTRO", "PENDIENTE", "NO_INCLUIR", "RECLAMADO"];
