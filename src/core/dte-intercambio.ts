import PostalMime from "postal-mime";
import { parsearEnvioDte, RecepcionInvalidaError, type DteRecibido } from "./dte-recepcion";
import { esFechaYmdValida } from "./fechas";
import { rutSii } from "./rut";

/**
 * Lectura de un correo que llegó a la casilla de intercambio DTE (`<sucursal>@dte.kiubo.io`).
 *
 * El XML de cada adjunto lo lee `core/dte-recepcion.ts` (`parsearEnvioDte`): ISO-8859-1 salvo que
 * declare otra cosa, rechaza DOCTYPE/ENTITY, separa CADA `<DTE>` y lee sus campos dentro de su
 * bloque. Acá sólo se arma el correo: qué adjuntos son XML, qué es un acuse, y qué documentos
 * traen lo mínimo para identificarlos.
 *
 * **Es contenido de un desconocido.** Un valor que no cabe en su columna no puede tumbar el correo
 * entero: un folio o tipo de 11 dígitos o un RUT inválido mandan el documento a `problemas`, y una
 * fecha imposible (2026-13-45) queda en `null`. El correo se guarda igual. Y lo que un correo puede
 * hacer gastar está topado: adjuntos XML, `<DTE>` leídos y problemas detallados.
 *
 * Dominio puro: no toca red, disco ni base de datos.
 */

/** dte: trae al menos un DTE · respuesta: acuse de un cliente (RespuestaDTE/EnvioRecibos) · sin_dte: nada útil · error: no se pudo leer. */
export type EstadoCorreo = "dte" | "respuesta" | "sin_dte" | "error";

/** Topes por correo: un proveedor real manda un sobre con unos pocos DTE, no miles. */
export const MAX_ADJUNTOS_XML = 20;
/** Cuenta todo `<DTE>` leído, válido o no, entre todos los adjuntos del correo. */
export const MAX_DTE_POR_CORREO = 500;
/** Problemas que se detallan; del resto queda la cuenta. */
const MAX_PROBLEMAS = 50;
/** `tipo_dte` y `folio` son INTEGER: un número más grande no es un folio, es basura o un ataque. */
const INT4_MAX = 2_147_483_647;

export interface DocumentoRecibido {
  rutReceptor: string;
  rutEmisor: string;
  razonSocialEmisor: string | null;
  tipoDte: number;
  folio: number;
  /** AAAA-MM-DD; `null` si `<FchEmis>` no es una fecha real. */
  fechaEmision: string | null;
  montoTotal: number;
  /** El `<DTE>` tal como llegó (ver `DteRecibido.xml`) y lo que `parsearEnvioDte` leyó de él. */
  dte: DteRecibido;
}

export interface CorreoAnalizado {
  remitente: string | null;
  asunto: string | null;
  messageId: string | null;
  estado: EstadoCorreo;
  /** Motivo legible de lo que no se pudo leer (adjunto inválido, DTE sin datos mínimos). */
  error: string | null;
  documentos: DocumentoRecibido[];
}

const enRango = (n: number | null): n is number => n !== null && n >= 1 && n <= INT4_MAX;

/** Un DTE sin tipo, folio o RUTs válidos no se puede identificar ni deduplicar: queda como problema. */
function aDocumento(d: DteRecibido): DocumentoRecibido | string {
  // `parsearEnvioDte` deja el texto crudo cuando el RUT no es válido; un RUT válido cabe en VARCHAR(20).
  const rutsValidos = rutSii(d.rutEmisor) !== "" && rutSii(d.rutRecep) !== "";
  if (!enRango(d.tipoDte) || !enRango(d.folio) || !rutsValidos) {
    return `DTE sin TipoDTE/Folio válidos o con RUT inválido${d.problemas.length ? ` (${d.problemas.join("; ")})` : ""}`;
  }
  return {
    rutReceptor: d.rutRecep,
    rutEmisor: d.rutEmisor,
    razonSocialEmisor: d.rznSoc,
    tipoDte: d.tipoDte,
    folio: d.folio,
    fechaEmision: d.fchEmis && esFechaYmdValida(d.fchEmis) ? d.fchEmis : null,
    montoTotal: d.mntTotal ?? 0,
    dte: d,
  };
}

/** Solo XML de verdad: un .docx/.xlsx (`openxmlformats`) o un SVG (`+xml`) no es un DTE. */
function esXml(a: { filename: string | null; mimeType: string }): boolean {
  return /\.xml$/i.test(a.filename ?? "") || a.mimeType === "application/xml" || a.mimeType === "text/xml";
}

function bytesDe(content: ArrayBuffer | Uint8Array | string): Buffer {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  return content instanceof Uint8Array ? Buffer.from(content.buffer, content.byteOffset, content.byteLength) : Buffer.from(content);
}

/** El acuse de un cliente a NUESTRAS facturas: no es una factura recibida. Se mira sólo la cabeza. */
const esRespuesta = (bytes: Buffer) =>
  /<(?:[\w.-]+:)?(RespuestaDTE|EnvioRecibos)\b/.test(bytes.subarray(0, 4096).toString("latin1"));

type Correo = Awaited<ReturnType<typeof PostalMime.parse>>;
type Adjunto = Correo["attachments"][number];

/** Un correo reenviado (`message/rfc822`) trae sus DTE adentro: se abren hasta 3 niveles EN TOTAL. */
const MAX_ANIDADOS = 3;

/**
 * postal-mime abre solo los reenviados "en línea" (hasta 10 niveles) y entrega los demás como adjunto.
 * Con 0, TODOS llegan como adjunto y los abre `adjuntosXml`, con un único presupuesto de 3 niveles:
 * sumar los 10 de postal-mime a una recursión propia dejaba 40 niveles (1,3 GB medidos).
 */
const OPCIONES_MIME = { maxRfc822NestingDepth: 0 } as const;

/**
 * Los adjuntos XML del correo, incluidos los de correos reenviados (lo que hace quien reenvía la
 * casilla vieja de Defontana). Para de juntar pasado el tope: con uno de más alcanza para saber que se
 * excedió. Un reenviado que no se puede leer, o más hondo que el tope, queda anotado como problema:
 * así el correo es `error` y conserva su crudo, en vez de desaparecer como `sin_dte`.
 */
async function adjuntosXml(email: Correo, nivel: number, acumulado: Adjunto[], problemas: string[]): Promise<Adjunto[]> {
  for (const a of email.attachments) {
    if (acumulado.length > MAX_ADJUNTOS_XML) break;
    if (a.mimeType === "message/rfc822") {
      if (nivel >= MAX_ANIDADOS) {
        problemas.push(`un correo reenviado está a más de ${MAX_ANIDADOS} niveles: no se abrió`);
        continue;
      }
      try {
        await adjuntosXml(await PostalMime.parse(bytesDe(a.content), OPCIONES_MIME), nivel + 1, acumulado, problemas);
      } catch (e) {
        problemas.push(`un correo reenviado adjunto no se pudo leer: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (esXml(a)) {
      acumulado.push(a);
    }
  }
  return acumulado;
}

/** Lee el correo crudo (RFC 822) y clasifica lo que trae. Nunca lanza: un correo ilegible es `error`. */
export async function analizarCorreo(crudo: Uint8Array): Promise<CorreoAnalizado> {
  let email: Correo;
  try {
    email = await PostalMime.parse(crudo, OPCIONES_MIME);
  } catch (e) {
    return {
      remitente: null,
      asunto: null,
      messageId: null,
      estado: "error",
      error: `MIME ilegible: ${e instanceof Error ? e.message : String(e)}`,
      documentos: [],
    };
  }

  const documentos: DocumentoRecibido[] = [];
  const problemas: string[] = [];
  let problemasOmitidos = 0;
  const anotar = (p: string) => {
    if (problemas.length < MAX_PROBLEMAS) problemas.push(p);
    else problemasOmitidos++;
  };
  // El tope cuenta TODO <DTE> leído, válido o no, y se reparte entre adjuntos: lo que un correo
  // puede hacer gastar al parser es fijo, venga como venga.
  let presupuesto = MAX_DTE_POR_CORREO;
  let hayRespuesta = false;
  const deReenviados: string[] = [];
  const xmls = await adjuntosXml(email, 0, [], deReenviados);
  deReenviados.forEach(anotar);
  if (xmls.length > MAX_ADJUNTOS_XML) {
    anotar(`trae ${xmls.length} adjuntos XML: se leyeron los primeros ${MAX_ADJUNTOS_XML}`);
  }
  for (const adjunto of xmls.slice(0, MAX_ADJUNTOS_XML)) {
    const nombre = adjunto.filename ?? "adjunto";
    const bytes = bytesDe(adjunto.content);
    if (esRespuesta(bytes)) {
      hayRespuesta = true;
      continue;
    }
    if (presupuesto === 0) {
      anotar(`${nombre}: no se leyó, el correo ya llegó a ${MAX_DTE_POR_CORREO} DTE`);
      continue;
    }
    let envio: { dtes: DteRecibido[]; truncado: boolean };
    try {
      envio = parsearEnvioDte(bytes, { maxDtes: presupuesto });
    } catch (e) {
      // Un XML que no es un DTE (SIN_DTE) no es un error del correo: puede ser cualquier adjunto.
      if (e instanceof RecepcionInvalidaError && e.codigo === "SIN_DTE") continue;
      anotar(`${nombre}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    presupuesto -= envio.dtes.length;
    if (envio.truncado) anotar(`${nombre}: trae más de ${MAX_DTE_POR_CORREO} DTE por correo; el resto no se leyó`);
    for (const d of envio.dtes) {
      const doc = aDocumento(d);
      if (typeof doc === "string") anotar(`${nombre}: ${doc}`);
      else documentos.push(doc);
    }
  }
  // El resumen va al final y no se corta: es lo que dice que hubo más.
  const resumen = problemasOmitidos > 0 ? ` · y ${problemasOmitidos} problema(s) más` : "";

  const estado: EstadoCorreo =
    documentos.length > 0 ? "dte" : problemas.length > 0 ? "error" : hayRespuesta ? "respuesta" : "sin_dte";
  return {
    remitente: email.from?.address ?? null,
    asunto: email.subject ?? null,
    messageId: email.messageId ?? null,
    estado,
    error: problemas.length > 0 ? problemas.join(" · ").slice(0, 4000 - resumen.length) + resumen : null,
    documentos,
  };
}
