/**
 * `RespuestaDTE` y `EnvioRecibos`: los documentos con que un receptor le responde a su proveedor.
 *
 * Port de `api-facturacion/api/core/dte-respuesta.ts`; desde R14 (`docs/PLAN-MIGRACION-CHONCHI.md`)
 * este archivo es el ORIGEN y aquel copia. Está calcado de `core/dte-sobre.ts`, que es el mismo
 * problema: contenedor con `@ID`, firma XML-DSig con los namespaces heredados, y serialización a
 * ISO-8859-1. Firma con `core/dte-firma.ts`, que digiere en UTF-8 y expande `&quot;`/`&apos;` en el
 * texto (las dos causas de los RFR de 2026-09): una glosa o un recinto con "Ñ" o comillas firmaba
 * mal con la versión anterior del firmador.
 *
 * No hay XSD local de `RespuestaEnvioDTE_v10.xsd` ni `EnvioRecibos_v10.xsd` (`docs/dte-boleta/xsd`
 * sólo trae los de DTE y boleta): el orden de los elementos sale de los comentarios de abajo y lo
 * pinea el test. Cuando se baje `schema_ic.zip` del SII, validar contra él.
 *
 * ── SON DOS DOCUMENTOS DISTINTOS, Y ESO GOBIERNA TODO ──────────────────────────────────────────
 *
 * No hay "el acuse". Hay tres actos y dos esquemas:
 *
 *  · `recibo` → `RespuestaDTE` / `RecepcionEnvio`. "Me llegó el ARCHIVO y lo pude leer". Es un acuse
 *    del ENVÍO, no del documento, y por eso exige datos de nivel sobre (`NmbEnvio`, `EnvioDTEID`)
 *    que solo existen si lo que se recibió fue un `<EnvioDTE>` y no un `<DTE>` suelto.
 *  · `recibo_mercaderias` → `EnvioRecibos` / `Recibo`. **Otro esquema, otra raíz, DOS niveles de
 *    firma.** Es el acuse de la Ley 19.983: el que vuelve la factura cedible y pagadera.
 *  · `reclamo` → `RespuestaDTE` / `ResultadoDTE` con `EstadoDTE=2`.
 *
 * `RecepcionEnvio` y `ResultadoDTE` son EXCLUYENTES dentro de una `RespuestaDTE`: el XSD lo impone
 * con un `<xs:choice>`, y aquí lo impone el tipo de `DetalleRespuesta`.
 *
 * ── DE DÓNDE SALEN LOS CAMPOS ──────────────────────────────────────────────────────────────────
 *
 * De `RespuestaEnvioDTE_v10.xsd`, `EnvioRecibos_v10.xsd` y `Recibos_v10.xsd` (pack `schema_ic.zip`
 * del SII), y de los formatos oficiales `formato_ic.pdf` y `desc_19983.pdf`. Las decisiones que no
 * son obvias están anotadas donde aparecen.
 *
 * Módulo PURO: no toca red, disco ni base de datos.
 */

import { escaparTextoXml, firmarDocumento, type CertificadoFirmante } from "./dte-firma";
import { siiTimestamp } from "./fechas";

const NS_SII = "http://www.sii.cl/SiiDte";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";

function tag(nombre: string, valor: string | number): string {
  return `<${nombre}>${escaparTextoXml(String(valor))}</${nombre}>`;
}
/** Un elemento que se OMITE cuando no hay dato. Ningún campo del formato admite valor vacío. */
function opc(nombre: string, valor: string | number | null | undefined, largo?: number): string {
  if (valor === null || valor === undefined) return "";
  const s = String(valor).trim();
  if (!s) return "";
  return tag(nombre, largo ? s.slice(0, largo) : s);
}

function entero(nombre: string, n: number, campo: string): string {
  // El invariante de dinero/identificadores enteros no se delega al esquema: un decimal aquí produce
  // un documento que el SII rechaza horas después.
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${campo} tiene que ser un entero no negativo, y vino ${n}`);
  }
  return tag(nombre, n);
}

// ── RespuestaDTE ────────────────────────────────────────────────────────────────────────────────

export interface CaratulaRespuesta {
  /** RUT que responde = receptor de los DTE = NUESTRO emisor. */
  rutResponde: string;
  /** RUT al que se le responde = emisor de los DTE = el proveedor. */
  rutRecibe: string;
  /** `IdRespuesta`: `positiveInteger` de ≤10 dígitos. **Arranca en 1: el XSD no admite 0.** */
  idRespuesta: number;
  nombreContacto?: string | null;
  fonoContacto?: string | null;
  mailContacto?: string | null;
}

/** 0=Recibido conforme · 1=Error de schema · 2=Error de firma · 3=RUT receptor no corresponde · 90=Repetido · 91=Ilegible · 99=Otros. */
export type EstadoRecepEnv = 0 | 1 | 2 | 3 | 90 | 91 | 99;
/** 0=Aceptado · 1=Aceptado con discrepancias · 2=Rechazado. */
export type EstadoDte = 0 | 1 | 2;

export interface DetalleRecepcionEnvio {
  /** `NmbEnvio`: el nombre del archivo recibido. No se inventa. */
  nombreEnvio: string;
  fechaRecepcion: Date;
  /** `CodEnvio`: número único que asigna QUIEN RECIBE. Ese sí es nuestro. */
  codigoEnvio: number;
  /** `EnvioDTEID`: el atributo `ID` del `<SetDTE>` recibido. */
  envioDteId: string;
  /** `DigestValue` de la firma DEL SOBRE. Se omite si no se pudo extraer con certeza. */
  digest?: string | null;
  rutEmisorEnvio?: string | null;
  rutReceptorEnvio?: string | null;
  estado: EstadoRecepEnv;
  glosa: string;
}

export interface DetalleResultadoDte {
  tipoDte: number;
  folio: number;
  /** `AAAA-MM-DD`. */
  fechaEmision: string;
  rutEmisor: string;
  rutReceptor: string;
  montoTotal: number;
  /** El envío en que llegó el documento. */
  codigoEnvio: number;
  estado: EstadoDte;
  glosa: string;
}

export type DetalleRespuesta =
  | { tipo: "recepcion"; envios: DetalleRecepcionEnvio[] }
  | { tipo: "resultado"; documentos: DetalleResultadoDte[] };

/**
 * Arma y firma un `<RespuestaDTE>`.
 *
 * `NroDetalles` se CUENTA aquí y no se recibe, por el mismo motivo que `SubTotDTE` en
 * `core/dte-sobre.ts`: un conteo que pasa el llamador es un conteo que se descuadra.
 */
export function construirRespuestaDte(
  caratula: CaratulaRespuesta,
  detalle: DetalleRespuesta,
  certificado: CertificadoFirmante,
  ahora: Date,
): string {
  const cantidad = detalle.tipo === "recepcion" ? detalle.envios.length : detalle.documentos.length;
  if (cantidad === 0) {
    throw new Error("Una RespuestaDTE sin detalle no responde nada.");
  }
  if (!Number.isSafeInteger(caratula.idRespuesta) || caratula.idRespuesta < 1) {
    // El XSD lo declara `positiveInteger`: el 0 que menciona el instructivo NO valida.
    throw new Error(`IdRespuesta tiene que ser un entero >= 1, y vino ${caratula.idRespuesta}`);
  }

  const cuerpo =
    detalle.tipo === "recepcion"
      ? detalle.envios.map(recepcionEnvio).join("")
      : detalle.documentos.map(resultadoDte).join("");

  const idResultado = "Resultado";
  const resultado =
    `<Resultado xmlns="${NS_SII}" xmlns:xsi="${NS_XSI}" ID="${idResultado}">` +
    `<Caratula version="1.0">` +
    tag("RutResponde", caratula.rutResponde) +
    tag("RutRecibe", caratula.rutRecibe) +
    tag("IdRespuesta", caratula.idRespuesta) +
    tag("NroDetalles", cantidad) +
    opc("NmbContacto", caratula.nombreContacto, 40) +
    opc("FonoContacto", caratula.fonoContacto, 40) +
    opc("MailContacto", caratula.mailContacto, 80) +
    tag("TmstFirmaResp", siiTimestamp(ahora)) +
    `</Caratula>` +
    cuerpo +
    `</Resultado>`;

  // El `<SignedInfo>` hereda el `xmlns:xsi` de la raíz; sin él la firma no valida. Es el mismo
  // motivo, y la misma solución, que en `core/dte-sobre.ts`.
  const firma = firmarDocumento(resultado, idResultado, certificado, ` xmlns:xsi="${NS_XSI}"`);

  return (
    `<RespuestaDTE xmlns="${NS_SII}" xmlns:xsi="${NS_XSI}" version="1.0"` +
    ` xsi:schemaLocation="${NS_SII} RespuestaEnvioDTE_v10.xsd">` +
    resultado +
    firma +
    `</RespuestaDTE>`
  );
}

function recepcionEnvio(e: DetalleRecepcionEnvio): string {
  return (
    `<RecepcionEnvio>` +
    tag("NmbEnvio", e.nombreEnvio.slice(0, 80)) +
    tag("FchRecep", siiTimestamp(e.fechaRecepcion)) +
    entero("CodEnvio", e.codigoEnvio, "CodEnvio") +
    tag("EnvioDTEID", e.envioDteId.slice(0, 80)) +
    opc("Digest", e.digest) +
    opc("RutEmisor", e.rutEmisorEnvio) +
    opc("RutReceptor", e.rutReceptorEnvio) +
    tag("EstadoRecepEnv", e.estado) +
    tag("RecepEnvGlosa", e.glosa.slice(0, 256)) +
    `</RecepcionEnvio>`
  );
}

function resultadoDte(d: DetalleResultadoDte): string {
  return (
    `<ResultadoDTE>` +
    tag("TipoDTE", d.tipoDte) +
    entero("Folio", d.folio, "Folio") +
    tag("FchEmis", d.fechaEmision) +
    tag("RUTEmisor", d.rutEmisor) +
    tag("RUTRecep", d.rutReceptor) +
    entero("MntTotal", d.montoTotal, "MntTotal") +
    entero("CodEnvio", d.codigoEnvio, "CodEnvio") +
    tag("EstadoDTE", d.estado) +
    tag("EstadoDTEGlosa", d.glosa.slice(0, 256)) +
    // `CodRchDsc` NO se emite: el propio formato del SII dice que su codificación queda "para ser
    // codificada a futuro", y el XSD lo tipa `negativeInteger`. Es opcional; inventarle un valor
    // sería declarar un código que no significa nada.
    `</ResultadoDTE>`
  );
}

/** Los BYTES ISO-8859-1 que se adjuntan al correo. */
export function serializarRespuestaDte(
  caratula: CaratulaRespuesta,
  detalle: DetalleRespuesta,
  certificado: CertificadoFirmante,
  ahora: Date,
): Buffer {
  const xml =
    `<?xml version="1.0" encoding="ISO-8859-1"?>\n` +
    construirRespuestaDte(caratula, detalle, certificado, ahora);
  return Buffer.from(xml, "latin1");
}

// ── EnvioRecibos (Ley 19.983) ───────────────────────────────────────────────────────────────────

/**
 * El texto de la declaración, **fijo** en el XSD (`Recibos_v10.xsd`, atributo `fixed`).
 *
 * Va byte a byte, incluido "mercaderias" SIN TILDE: es un valor fijo del esquema, no una redacción
 * nuestra. Cualquier corrección ortográfica invalida el documento.
 */
export const DECLARACION_LEY_19983 =
  "El acuse de recibo que se declara en este acto, de acuerdo a lo dispuesto en la letra b) del " +
  "Art. 4, y la letra c) del Art. 5 de la Ley 19.983, acredita que la entrega de mercaderias o " +
  "servicio(s) prestado(s) ha(n) sido recibido(s).";

/**
 * Tipos que admite `DocType` en `SiiTypes_v10.xsd`.
 *
 * **No incluye el 43** aunque `desc_19983.pdf` lo liste: cuando el PDF y el XSD se contradicen manda
 * el XSD, que es contra lo que el SII valida. Un Recibo de un 43 no pasa el esquema.
 */
export const TIPOS_CON_RECIBO = new Set([33, 34, 46, 52, 56, 61]);

export interface CaratulaRecibos {
  rutResponde: string;
  rutRecibe: string;
  nombreContacto?: string | null;
  fonoContacto?: string | null;
  mailContacto?: string | null;
}

export interface DocumentoDeRecibo {
  tipoDoc: number;
  folio: number;
  /** `AAAA-MM-DD`. */
  fechaEmision: string;
  rutEmisor: string;
  rutReceptor: string;
  montoTotal: number;
  /** `Recinto`: dónde se materializó la recepción conforme. OBLIGATORIO y no se puede inventar. */
  recinto: string;
  /** RUT de quien firma (el dueño del certificado). */
  rutFirma: string;
}

/**
 * Arma y firma un `<EnvioRecibos>`.
 *
 * **DOS niveles de firma, y no es opcional**: una por cada `<Recibo>` y otra sobre el `<SetRecibos>`
 * completo. Lo dice el formato del SII con esas palabras ("sobre cada uno de los recibos
 * individuales y sobre toda la información"). Que N firmas hermanas no rompan nuestro atajo de
 * canonicalización ya está razonado y chequeado en `core/dte-firma.ts`: es el mismo caso que un
 * sobre con dos boletas.
 *
 * La firma de cada `<Recibo>` se calcula en su CONTEXTO: el `<DocumentoRecibo>` se digiere con el
 * `xmlns` y el `xmlns:xsi` que hereda del `<SetRecibos>`, y su `<SignedInfo>` con el `xmlns:xsi`.
 * Es lo que computa un verificador XML-DSig estándar (C14N inclusivo sobre el nodo dentro del
 * documento), que es lo que usa el software del proveedor. La versión de api-facturacion digería el
 * `<DocumentoRecibo>` suelto, como el `<Documento>` de un DTE: eso sirve con el SII, que verifica
 * el DTE suelto, pero el Recibo no lo verifica el SII sino el proveedor, y un verificador estándar
 * lo rechazaba.
 */
export function construirEnvioRecibos(
  caratula: CaratulaRecibos,
  documentos: DocumentoDeRecibo[],
  certificado: CertificadoFirmante,
  ahora: Date,
): string {
  if (documentos.length === 0) {
    throw new Error("Un EnvioRecibos sin recibos no acredita nada.");
  }
  for (const d of documentos) {
    if (!TIPOS_CON_RECIBO.has(d.tipoDoc)) {
      throw new Error(
        `El esquema del SII no admite un Recibo para el tipo ${d.tipoDoc}. ` +
          `Los admitidos son ${[...TIPOS_CON_RECIBO].join(", ")}.`,
      );
    }
    if (!d.recinto.trim()) {
      throw new Error("El Recibo de la Ley 19.983 exige el recinto, y no se puede inventar.");
    }
  }

  const recibos = documentos
    .map((d, i) => {
      const id = `R${i + 1}`;
      const doc =
        `<DocumentoRecibo ID="${id}">` +
        tag("TipoDoc", d.tipoDoc) +
        entero("Folio", d.folio, "Folio") +
        tag("FchEmis", d.fechaEmision) +
        tag("RUTEmisor", d.rutEmisor) +
        tag("RUTRecep", d.rutReceptor) +
        entero("MntTotal", d.montoTotal, "MntTotal") +
        tag("Recinto", d.recinto.slice(0, 80)) +
        tag("RutFirma", d.rutFirma) +
        tag("Declaracion", DECLARACION_LEY_19983) +
        tag("TmstFirmaRecibo", siiTimestamp(ahora)) +
        `</DocumentoRecibo>`;
      // Se digiere en su contexto (ver arriba) y se embebe sin las declaraciones, que hereda.
      const enContexto = doc.replace("<DocumentoRecibo ", `<DocumentoRecibo xmlns="${NS_SII}" xmlns:xsi="${NS_XSI}" `);
      const firma = firmarDocumento(enContexto, id, certificado, ` xmlns:xsi="${NS_XSI}"`);
      return `<Recibo version="1.0">${doc}${firma}</Recibo>`;
    })
    .join("");

  const idSet = "SetRecibos";
  const setRecibos =
    `<SetRecibos xmlns="${NS_SII}" xmlns:xsi="${NS_XSI}" ID="${idSet}">` +
    `<Caratula version="1.0">` +
    tag("RutResponde", caratula.rutResponde) +
    tag("RutRecibe", caratula.rutRecibe) +
    opc("NmbContacto", caratula.nombreContacto, 40) +
    opc("FonoContacto", caratula.fonoContacto, 40) +
    opc("MailContacto", caratula.mailContacto, 80) +
    tag("TmstFirmaEnv", siiTimestamp(ahora)) +
    `</Caratula>` +
    recibos +
    `</SetRecibos>`;

  const firma = firmarDocumento(setRecibos, idSet, certificado, ` xmlns:xsi="${NS_XSI}"`);

  return (
    `<EnvioRecibos xmlns="${NS_SII}" xmlns:xsi="${NS_XSI}" version="1.0"` +
    ` xsi:schemaLocation="${NS_SII} EnvioRecibos_v10.xsd">` +
    setRecibos +
    firma +
    `</EnvioRecibos>`
  );
}

export function serializarEnvioRecibos(
  caratula: CaratulaRecibos,
  documentos: DocumentoDeRecibo[],
  certificado: CertificadoFirmante,
  ahora: Date,
): Buffer {
  const xml =
    `<?xml version="1.0" encoding="ISO-8859-1"?>\n` +
    construirEnvioRecibos(caratula, documentos, certificado, ahora);
  return Buffer.from(xml, "latin1");
}
