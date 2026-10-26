import { parsearFechaChilena } from "./fechas";

/**
 * Registro de Aceptación/Reclamo de un DTE recibido (WS `WSREGISTRORECLAMODTE`). Dominio puro: arma
 * los sobres SOAP y lee las respuestas; la red vive en `sii/registro-reclamo.ts`.
 *
 * ## Es el canal que produce el efecto tributario
 *
 * Mandarle el acuse por correo al proveedor lo entera a él; el SII no. Lo que corta el plazo de 8
 * días de la Ley 19.983 (modificada por la Ley 20.956) —y lo que habilita o impide la cesión del
 * crédito— es el evento registrado acá.
 *
 * ## Fuente
 *
 * `Webservice_Registro_Reclamo_DTE_V1.1.pdf` del SII (16/03/2017), leído completo el 2026-10-26:
 * endpoints, métodos, tipos admitidos (33, 34, 43), acciones y la tabla de `codResp`. El WSDL vivo
 * (`ws1.sii.cl/...?wsdl`) confirma binding `rpc/literal`, `soapAction=""` y que las cuatro entradas
 * son `xsd:string`. `consultarFechaRecepcionSii` devuelve un `xsd:string` suelto, el resto un
 * `respuestaTo` con `codResp` y `descResp`.
 *
 * **Probado en vivo** contra producción el 2026-10-26 (certificado de Jorge, 11.598.736-4, sólo
 * lectura, facturas reales recibidas y emitidas): fecha de recepción, códigos 15/16/22 y los campos de
 * cada evento, que son `codEvento`, `descEvento`, `rutResponsable`, `dvResponsable` y `fechaEvento`
 * (`dd-mm-aaaa hh:mm:ss`). `parsearEventos` igual conserva todo en `campos`. Registrar eventos
 * (`ingresarAceptacionReclamoDoc`) NO se probó en vivo: tiene efecto tributario real.
 *
 * El historial trae también eventos que no son del receptor, p. ej. `PAG` ("DTE Pagado al Contado"),
 * que registra el EMISOR. `eventoVigente` sólo mira los cinco del receptor.
 *
 * ## Autenticación
 *
 * Token semilla→token (el mismo del envío de DTE) en la cookie `TOKEN`. Pueden usarlo el emisor, el
 * receptor y el tenedor vigente; registrar eventos, sólo el receptor (código 17).
 */

export type AmbienteSii = "certificacion" | "produccion";

export const URL_REGISTRO_RECLAMO: Record<AmbienteSii, string> = {
  produccion: "https://ws1.sii.cl/WSREGISTRORECLAMODTE/registroreclamodteservice",
  certificacion: "https://ws2.sii.cl/WSREGISTRORECLAMODTECERT/registroreclamodteservice",
};

const NS_WS = "http://ws.registroreclamodte.diii.sdi.sii.cl";

/** Las cinco acciones que el servicio registra. No hay más, y una desconocida no se inventa. */
export const ACCIONES = ["ACD", "RCD", "ERM", "RFP", "RFT"] as const;
export type AccionReclamo = (typeof ACCIONES)[number];

export const DESCRIPCION_ACCION: Record<AccionReclamo, string> = {
  ACD: "Acepta contenido del documento",
  RCD: "Reclamo al contenido del documento",
  ERM: "Otorga recibo de mercaderías o servicios",
  RFP: "Reclamo por falta parcial de mercaderías",
  RFT: "Reclamo por falta total de mercaderías",
};

/** Las acciones que son RECLAMO. Un reclamo deja el DTE no cedible y es excluyente con ACD/ERM. */
export const RECLAMOS: ReadonlySet<string> = new Set(["RCD", "RFP", "RFT"]);

/** Los únicos tipos que el servicio opera (manual, campo 3). */
export const TIPOS_REGISTRO_RECLAMO: ReadonlySet<number> = new Set([33, 34, 43]);

/** Tabla de `codResp` del manual, completa. */
export const GLOSAS_COD_RESP: Readonly<Record<number, string>> = {
  0: "Acción completada OK",
  1: "RUT emisor erróneo",
  2: "Número de folio erróneo",
  3: "Tipo de documento no corresponde",
  4: "Acción inválida",
  5: "DTE ya está reclamado",
  6: "No se puede acusar recibo de mercadería de un DTE previamente reclamado",
  7: "Evento registrado previamente",
  8: "Pasados 8 días después de la recepción no es posible registrar reclamos o eventos",
  9: "No existen registros de acuerdo a los parámetros ingresados",
  10: "Documento no emitido y/o recibido en el SII desde el 14 de enero de 2017 en adelante",
  11: "No se puede reclamar un DTE previamente aceptado",
  12: "No se puede dar por aceptado un DTE previamente rechazado",
  13: "No se puede reclamar un DTE previamente registrado con recibo de mercadería",
  14: "Acción autorizada sólo para empresa receptora o emisora",
  15: "Listado de eventos del documento",
  16: "Documento no presenta eventos de reclamos o acuse de recibo",
  17: "Acción autorizada sólo para empresa receptora",
  18: "Documento no ha sido recibido",
  19: "Reclamo de mercaderías ya realizado",
  20: "Tipo de documento no es cedible",
  21: "DTE no cedible: referenciado por nota de crédito de anulación del emisor dentro de los primeros 8 días",
  22: "No existe registro de reclamo o de recepción de mercadería o servicios",
  23: "DTE cedible, sin reclamos",
  24: "DTE no cedible: reclamado por el receptor",
  25: "DTE cedible: pasados 8 días se entiende dado el acuse de recibo",
  [-1]: "Error interno del SII: reintentar más tarde",
};

export type ResultadoAccion = "registrado" | "ya_estaba" | "rechazado" | "reintentar";

/**
 * Qué significa cada código al REGISTRAR un evento.
 *
 * Un código desconocido se trata como `reintentar`, **nunca como éxito**: no se marca nada como
 * logrado sin evidencia explícita del SII. 7 es éxito (el evento ESTÁ en el SII), y por eso reintentar
 * un ingreso que quedó incierto es seguro: la segunda vez responde 7.
 *
 * Con la acción y la glosa se reconocen dos "ya estaba" más: 5 ("DTE ya está reclamado por XXX")
 * cuando XXX es el MISMO reclamo que se pidió —un reintento de un RCD que sí entró—, y 19 ("reclamo
 * de mercaderías ya realizado") cuando se pidió un reclamo de mercaderías (RFP/RFT).
 */
export function clasificarAccion(codigo: number, accion?: AccionReclamo, glosa = ""): ResultadoAccion {
  if (codigo === 0) return "registrado";
  if (codigo === 7) return "ya_estaba";
  if (codigo === 5 && accion && RECLAMOS.has(accion) && new RegExp(`\\b${accion}\\b`).test(glosa)) return "ya_estaba";
  if (codigo === 19) return accion === "RFP" || accion === "RFT" || accion === undefined ? "ya_estaba" : "rechazado";
  if (codigo >= 1 && codigo <= 18) return "rechazado";
  return "reintentar";
}

export type Cedibilidad = "cedible" | "no_cedible" | "sin_eventos" | "error" | "desconocido";

/** Los códigos de `consultarDocDteCedible`. */
export function clasificarCedible(codigo: number): Cedibilidad {
  if (codigo === 23 || codigo === 25) return "cedible";
  if (codigo === 20 || codigo === 21 || codigo === 24) return "no_cedible";
  if (codigo === 22) return "sin_eventos";
  if ([1, 2, 10, 18].includes(codigo)) return "error";
  return "desconocido";
}

export interface DocumentoSii {
  /** RUT del EMISOR DEL DOCUMENTO (para una compra, el proveedor), con guion. */
  rutEmisor: string;
  tipoDoc: number;
  folio: number;
}

function partirRut(rut: string): { cuerpo: string; dv: string } {
  const m = /^(\d{1,8})-([\dkK])$/.exec(rut.trim());
  if (!m) throw new Error(`RUT con formato inesperado para el SII: ${rut}`);
  // "K" SIEMPRE en mayúscula: el servicio lo exige explícitamente.
  return { cuerpo: m[1]!, dv: m[2]!.toUpperCase() };
}

/** Valida ANTES de salir a la red: pedirle al SII algo que su contrato excluye es un código 3 seguro. */
export function assertTipoOperado(tipoDoc: number): void {
  if (!TIPOS_REGISTRO_RECLAMO.has(tipoDoc)) {
    throw new Error(
      `El registro del SII sólo opera los tipos ${[...TIPOS_REGISTRO_RECLAMO].join(", ")}; ` +
        `este documento es tipo ${tipoDoc}.`,
    );
  }
}

function sobre(metodo: string, doc: DocumentoSii, extra = ""): string {
  assertTipoOperado(doc.tipoDoc);
  if (!Number.isInteger(doc.folio) || doc.folio < 1) throw new Error(`Folio inválido: ${doc.folio}`);
  const { cuerpo, dv } = partirRut(doc.rutEmisor);
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ws="${NS_WS}">` +
    `<soapenv:Header/><soapenv:Body><ws:${metodo}>` +
    `<rutEmisor>${cuerpo}</rutEmisor><dvEmisor>${dv}</dvEmisor>` +
    `<tipoDoc>${doc.tipoDoc}</tipoDoc><folio>${doc.folio}</folio>${extra}` +
    `</ws:${metodo}></soapenv:Body></soapenv:Envelope>`
  );
}

export function sobreIngresarAccion(doc: DocumentoSii, accion: AccionReclamo): string {
  if (!(ACCIONES as readonly string[]).includes(accion)) throw new Error(`Acción inválida: ${accion}`);
  return sobre("ingresarAceptacionReclamoDoc", doc, `<accionDoc>${accion}</accionDoc>`);
}
export const sobreListarEventos = (doc: DocumentoSii) => sobre("listarEventosHistDoc", doc);
export const sobreConsultarCedible = (doc: DocumentoSii) => sobre("consultarDocDteCedible", doc);
export const sobreFechaRecepcion = (doc: DocumentoSii) => sobre("consultarFechaRecepcionSii", doc);

// ── Respuestas ────────────────────────────────────────────────────────────────────────────────

/** Contenido de la primera etiqueta `tag`, con o sin prefijo de namespace. */
function valor(xml: string, tag: string): string | null {
  const m = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, "i").exec(xml);
  return m ? desescapar(m[1]!.trim()) : null;
}

function desescapar(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Un SOAP Fault es un error del servicio, no una respuesta de negocio. */
export function faultDe(xml: string): string | null {
  if (!/<(?:[\w.-]+:)?Fault\b/.test(xml)) return null;
  return valor(xml, "faultstring") ?? "SOAP Fault sin faultstring";
}

export interface RespuestaRegistro {
  codigo: number;
  glosa: string;
}

/** `codResp`/`descResp` de un `respuestaTo`. `null` si la respuesta no los trae. */
export function parsearRespuesta(xml: string): RespuestaRegistro | null {
  const crudo = valor(xml, "codResp");
  if (crudo === null || !/^-?\d+$/.test(crudo)) return null;
  const codigo = Number(crudo);
  return { codigo, glosa: valor(xml, "descResp") || GLOSAS_COD_RESP[codigo] || "" };
}

export interface EventoSii {
  /** ACD, RCD, ERM, RFP, RFT, y los que registre el SII o un tercero (p. ej. cesión). */
  codigo: string | null;
  descripcion: string | null;
  rutResponsable: string | null;
  /** ISO con offset de Santiago; `null` si el SII no la dio en un formato reconocible. */
  fecha: string | null;
  /** Todos los campos del elemento tal como vinieron: lo que no se mapeó no se pierde. */
  campos: Record<string, string>;
}

/** Hijos simples (`<a>texto</a>`) de un bloque, sin prefijo. */
function camposSimples(bloque: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of bloque.matchAll(/<(?:[\w.-]+:)?([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?\1>/g)) {
    out[m[1]!] = desescapar(m[2]!.trim());
  }
  return out;
}

const primero = (c: Record<string, string>, ...nombres: string[]): string | null => {
  for (const n of nombres) {
    const k = Object.keys(c).find((x) => x.toLowerCase() === n.toLowerCase());
    if (k && c[k]) return c[k]!;
  }
  return null;
};

/**
 * Los eventos de `listarEventosHistDoc` (código 15). Con 16 no hay eventos y devuelve `[]`.
 * Cada elemento de la lista se lee genérico (ver encabezado).
 */
export function parsearEventos(xml: string): EventoSii[] {
  const eventos: EventoSii[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?listaEventosDoc(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?listaEventosDoc>/gi)) {
    const campos = camposSimples(m[1]!);
    const rut = primero(campos, "rutResponsable");
    const dv = primero(campos, "dvResponsable");
    eventos.push({
      codigo: primero(campos, "codEvento", "codigoEvento", "evento")?.toUpperCase() ?? null,
      descripcion: primero(campos, "descEvento", "descripcionEvento", "glosaEvento"),
      rutResponsable: rut ? (dv ? `${rut}-${dv.toUpperCase()}` : rut) : null,
      fecha: parsearFechaChilena(primero(campos, "fechaEvento", "fecha")),
      campos,
    });
  }
  return eventos;
}

/**
 * El evento del RECEPTOR que manda sobre el documento, de los que trae el historial.
 *
 * Un reclamo es definitivo (no se puede aceptar después), así que pesa más que una aceptación; entre
 * ACD y ERM, ERM es el acuse de la Ley 19.983. Devuelve `null` si no hay ninguno de los cinco.
 */
export function eventoVigente(eventos: readonly EventoSii[]): AccionReclamo | null {
  const codigos = new Set(eventos.map((e) => e.codigo));
  for (const c of ["RFT", "RFP", "RCD", "ERM", "ACD"] as const) if (codigos.has(c)) return c;
  return null;
}

/**
 * La fecha de recepción del documento en el SII (`<return>21-02-2017 19:02:03</return>`).
 * Es el reloj de los 8 días. `null` si no vino una fecha: inventarla sería calcular un plazo falso.
 */
export function parsearFechaRecepcion(xml: string): string | null {
  const ret = valor(xml, "return");
  return ret ? parsearFechaChilena(ret) : null;
}
