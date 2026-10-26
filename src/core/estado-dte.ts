/**
 * Consulta de estado de un DTE (`QueryEstDte.jws`).
 * Dominio puro: sobres y lectura de respuestas; la red vive en `sii/estado-dte.ts`.
 *
 * Responde "¿este documento existe en el SII y sus datos coinciden?". Para un DTE RECIBIDO es la
 * prueba de que la factura de un proveedor no es inventada ni adulterada en monto o fecha.
 *
 * ## Fuente
 *
 * `Manual de Desarrollador Externo — Consulta de Estado DTE` (OI2004_CEDTE_MDE_1.10, SII,
 * 22/12/2010), leído completo el 2026-10-26: los 11 parámetros, la fecha en `DDMMAAAA`, la
 * respuesta como XML ESCAPADO dentro de `getEstDteReturn`, las tablas de ESTADO (Tabla 3-4),
 * ERR_CODE (3-9), errores de token 001/002/003 (3-10) y los −1..−4 (3-11).
 *
 * El sobre va sin prefijo de namespace en el método, igual que el `getEstUp` de Kiubo
 * (`belen-abos/api/workers/dte-sii.ts`), que SÍ está probado contra maullin y palena.
 *
 * **Probado en vivo** contra palena el 2026-10-26 con facturas reales recibidas y emitidas: DOK, con
 * la respuesta en la forma del manual. El SII responde 503 con alguna frecuencia: el cliente reintenta.
 *
 * `QueryEstDteAv` (la variante que además compara la firma) NO se ofrece: en la misma prueba el SII
 * rechazó el sobre armado según implementaciones de terceros ("Transacción Rechazada") y no hay
 * manual a mano para corregirlo.
 */

export type AmbienteSii = "certificacion" | "produccion";

export const BASE_DTEWS: Record<AmbienteSii, string> = {
  produccion: "https://palena.sii.cl/DTEWS",
  certificacion: "https://maullin.sii.cl/DTEWS",
};

/** Tabla 3-4 del manual. */
export const GLOSAS_ESTADO_DTE: Readonly<Record<string, string>> = {
  DOK: "Documento recibido por el SII. Datos coinciden con los registrados",
  DNK: "Documento recibido por el SII pero datos NO coinciden con los registrados",
  FAU: "Documento no recibido por el SII",
  FNA: "Documento no autorizado",
  FAN: "Documento anulado",
  EMP: "Empresa no autorizada a emitir documentos tributarios electrónicos",
  TMD: "Existe nota de débito que modifica texto del documento",
  TMC: "Existe nota de crédito que modifica textos del documento",
  MMD: "Existe nota de débito que modifica montos del documento",
  MMC: "Existe nota de crédito que modifica montos del documento",
  AND: "Existe nota de débito que anula el documento",
  ANC: "Existe nota de crédito que anula el documento",
  "001": "Cookie inactivo (o token no existe)",
  "002": "Token inactivo",
  "003": "Token no existe",
};

/**
 * Lo que un sistema tiene que DECIDIR con el estado. Es la salida accionable.
 *
 * - `valido`: existe y coincide (DOK), o coincide pero tiene notas que lo modifican (T*, M*) —sigue
 *   siendo un documento real; las notas se procesan aparte.
 * - `no_coincide`: existe pero el monto/fecha/receptor que preguntamos no es el registrado. Es la
 *   señal de adulteración: NO pagar sin revisar.
 * - `no_recibido`: el SII no lo tiene (aún, o nunca). Un DTE recién emitido puede tardar.
 * - `invalido`: no autorizado, empresa no autorizada.
 * - `anulado`: anulado directamente o por una nota.
 * - `token`: el token venció o no existe — se re-autentica, no es un dato del documento.
 * - `desconocido`: algo que no está en el manual. Nunca se trata como válido.
 */
export type ClaseEstadoDte = "valido" | "no_coincide" | "no_recibido" | "invalido" | "anulado" | "token" | "desconocido";

export function clasificarEstadoDte(estado: string): ClaseEstadoDte {
  switch (estado) {
    case "DOK":
    case "TMD":
    case "TMC":
    case "MMD":
    case "MMC":
      return "valido";
    case "DNK":
      return "no_coincide";
    case "FAU":
      return "no_recibido";
    case "FNA":
    case "EMP":
      return "invalido";
    case "FAN":
    case "AND":
    case "ANC":
      return "anulado";
    case "001":
    case "002":
    case "003":
      return "token";
    default:
      return "desconocido";
  }
}

export interface ConsultaEstadoDte {
  /** RUT de quien consulta (el titular del certificado con que se pidió el token). */
  rutConsultante: string;
  /** RUT del EMISOR del documento. */
  rutEmisor: string;
  rutReceptor: string;
  tipoDte: number;
  folio: number;
  /** `AAAA-MM-DD`. */
  fechaEmision: string;
  montoTotal: number;
}

function partirRut(rut: string): { cuerpo: string; dv: string } {
  const m = /^(\d{1,8})-([\dkK])$/.exec(rut.trim());
  if (!m) throw new Error(`RUT con formato inesperado para el SII: ${rut}`);
  return { cuerpo: m[1]!, dv: m[2]!.toUpperCase() };
}

/** `AAAA-MM-DD` → `DDMMAAAA`, que es como lo pide el servicio. */
export function fechaDdmmaaaa(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`Fecha de emisión inválida (se espera AAAA-MM-DD): ${ymd}`);
  return `${m[3]}${m[2]}${m[1]}`;
}

/** Los valores van a un XML: sólo dígitos, K o el token alfanumérico. Nada más entra. */
function seguro(v: string, que: string): string {
  if (!/^[\w-]*$/.test(v)) throw new Error(`Valor inválido para ${que}: ${JSON.stringify(v.slice(0, 40))}`);
  return v;
}

export function sobreEstadoDte(c: ConsultaEstadoDte, token: string): string {
  const cons = partirRut(c.rutConsultante);
  const emi = partirRut(c.rutEmisor);
  const rec = partirRut(c.rutReceptor);
  if (!Number.isInteger(c.montoTotal) || c.montoTotal < 0) throw new Error(`Monto inválido: ${c.montoTotal}`);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soapenv:Body><getEstDte>` +
    `<RutConsultante>${cons.cuerpo}</RutConsultante><DvConsultante>${cons.dv}</DvConsultante>` +
    `<RutCompania>${emi.cuerpo}</RutCompania><DvCompania>${emi.dv}</DvCompania>` +
    `<RutReceptor>${rec.cuerpo}</RutReceptor><DvReceptor>${rec.dv}</DvReceptor>` +
    `<TipoDte>${c.tipoDte}</TipoDte><FolioDte>${c.folio}</FolioDte>` +
    `<FechaEmisionDte>${fechaDdmmaaaa(c.fechaEmision)}</FechaEmisionDte>` +
    `<MontoDte>${c.montoTotal}</MontoDte><Token>${seguro(token, "el token")}</Token>` +
    `</getEstDte></soapenv:Body></soapenv:Envelope>`
  );
}

export interface EstadoDte {
  estado: string;
  clase: ClaseEstadoDte;
  glosa: string | null;
  errCode: string | null;
  glosaErr: string | null;
  numAtencion: string | null;
}

/**
 * Lee la respuesta. Viene ESCAPADA dentro de `getEstDteReturn`: se desescapa y se busca el
 * `ESTADO` (con o sin prefijo `SII:`). `null` si no hay estado: eso es un error, no un "desconocido".
 */
export function parsearEstadoDte(respuesta: string): EstadoDte | null {
  const plano = respuesta
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  const v = (tag: string) =>
    new RegExp(`<(?:SII:)?${tag}>\\s*([\\s\\S]*?)\\s*</(?:SII:)?${tag}>`, "i").exec(plano)?.[1]?.trim() ?? null;
  const estado = v("ESTADO");
  if (!estado) return null;
  return {
    estado,
    clase: clasificarEstadoDte(estado),
    // El manual usa GLOSA en la tabla y GLOSA_ESTADO en los ejemplos del capítulo 4: se aceptan ambos.
    glosa: v("GLOSA_ESTADO") ?? v("GLOSA") ?? GLOSAS_ESTADO_DTE[estado] ?? null,
    errCode: v("ERR_CODE"),
    glosaErr: v("GLOSA_ERR"),
    numAtencion: v("NUM_ATENCION"),
  };
}
