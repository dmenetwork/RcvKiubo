import { createHash } from "node:crypto";
import { cleanRut, rutSii } from "./rut";
import { clasificarImpuestos } from "./dte-impuestos";
import { contenidoDe, elemento, elementos } from "./xml-lineal";

/**
 * Lectura de un `<EnvioDTE>` RECIBIDO en la casilla de intercambio (Ola 4 de
 * `docs/PLAN-MIGRACION-CHONCHI.md`).
 *
 * ## Es XML de un desconocido, y eso ordena todo
 *
 * A la casilla le puede escribir cualquiera. Por eso:
 *
 * - **Sin parser DOM.** Se lee con las mismas utilidades de string que el resto de `core/dte-*`.
 *   Sin DOM no hay expansión de entidades externas (XXE), y además se rechaza de entrada cualquier
 *   `<!DOCTYPE`/`<!ENTITY`: un DTE del SII no los usa nunca, así que su presencia sólo puede ser un
 *   ataque o un archivo que no es un DTE.
 * - **Tope de 8 MB.** Un DTE real pesa kilobytes; lo demás es abuso o un adjunto equivocado.
 * - **Nada de lo que se lee aquí prueba algo.** Esto sólo extrae; la criptografía (firma del
 *   documento, FRMA del CAF, FRMT del timbre) está en `core/dte-verificacion.ts`, y hasta que pase
 *   no se crea cuenta por pagar ni se acepta (R6).
 *
 * ## Cada `<DTE>` del sobre, no el primero
 *
 * Un `<EnvioDTE>` puede traer varios documentos. La versión de api-facturacion
 * (`workers/recepcion.ts`) leía los campos con un `exec` sobre el archivo entero, o sea sólo el
 * primer `<DTE>`: las facturas 2 y 3 de un sobre de tres se perdían sin aviso, con el plazo de 8
 * días corriendo. Aquí se separa cada `<DTE>` y se lee dentro de su propio bloque (R14).
 *
 * ## El texto crudo se custodia tal cual llegó
 *
 * `xml` de cada documento es el `<DTE>…</DTE>` exacto, carácter por carácter: su firma y su timbre
 * se verificaron sobre esos bytes y cualquier "limpieza" los invalida. El `sha256` es de esos
 * bytes, en la codificación del archivo (ISO-8859-1 salvo que declare otra).
 *
 * Dominio puro: no toca red, disco ni base de datos.
 */

/** 8 MB. Un DTE real ronda los kilobytes; el resto es abuso o un archivo equivocado. */
export const MAX_BYTES_ENVIO = 8 * 1024 * 1024;

export type CodigoRecepcionInvalida = "VACIO" | "DEMASIADO_GRANDE" | "DTD_PROHIBIDO" | "SIN_DTE";

/** El archivo entero no se puede leer como envío de DTE. Un DTE mal armado NO tira: va a `problemas`. */
export class RecepcionInvalidaError extends Error {
  readonly codigo: CodigoRecepcionInvalida;
  constructor(codigo: CodigoRecepcionInvalida, motivo: string) {
    super(motivo);
    this.name = "RecepcionInvalidaError";
    this.codigo = codigo;
  }
}

export type Codificacion = "latin1" | "utf8";

export interface CaratulaRecibida {
  rutEmisor: string | null;
  rutEnvia: string | null;
  rutReceptor: string | null;
  fchResol: string | null;
  nroResol: string | null;
  tmstFirmaEnv: string | null;
}

/** Un `<ImptoReten>` de los totales: impuesto adicional (ILA, específicos) o retención. */
export interface ImpuestoRecibido {
  codigo: number;
  tasa: number | null;
  monto: number;
}

/** Una `<Referencia>`. `TpoDocRef` 801 es la orden de compra: así se vincula a la OC. */
export interface ReferenciaRecibida {
  /** Texto, no número: el SII admite códigos como `SET` o `HES` además de los tipos DTE. */
  tpoDocRef: string | null;
  /** Texto: el folio de una OC del comprador puede ser alfanumérico. */
  folioRef: string | null;
  fchRef: string | null;
  codRef: number | null;
  razonRef: string | null;
}

export interface DteRecibido {
  tipoDte: number | null;
  folio: number | null;
  fchEmis: string | null;
  /** Forma SII (`76086428-5`) si el RUT es válido; si no, el texto tal cual (y un problema). */
  rutEmisor: string;
  rznSoc: string | null;
  giroEmis: string | null;
  rutRecep: string;
  mntNeto: number | null;
  mntExe: number | null;
  iva: number | null;
  imptoReten: ImpuestoRecibido[];
  /** Crédito 65% empresas constructoras: RESTA del total. */
  credEc: number | null;
  /** Garantía por depósito de envases: SUMA al total. */
  grntDep: number | null;
  /** Comisiones y otros cargos (liquidación factura y afines): RESTAN del total. */
  valComNeto: number | null;
  valComExe: number | null;
  valComIva: number | null;
  mntTotal: number | null;
  referencias: ReferenciaRecibida[];
  /** El `<DTE>…</DTE>` exacto como llegó. NUNCA re-serializar: las firmas son sobre estos bytes. */
  xml: string;
  /** sha256 hex de `xml` en la codificación del archivo. */
  sha256: string;
  /** En qué codificación se leyó el archivo (la usa la verificación del timbre y la custodia). */
  codificacion: Codificacion;
  /** Defectos de estructura (falta el folio, un monto no es entero…). Con uno, es rechazo local. */
  problemas: string[];
}

/**
 * Una línea de `<SubTotInfo>` (Subtotales Informativos). En la boleta es donde va el ILA: no suma al
 * total, se informa (`core/boleta-xml.ts`, `core/tax.ts#summarizeBoletaDocument`).
 */
export interface SubtotalInformativoLeido {
  glosa: string | null;
  /** `<SubTotAdicSTI>`: el impuesto adicional del grupo. `null` si el subtotal no lo trae. */
  adicional: number | null;
}

/**
 * Lo que se lee de un `<DTE>`, más lo que sólo le interesa a quien lee documentos PROPIOS (el libro de
 * ventas): el nombre del receptor y los subtotales informativos. Va aparte de `DteRecibido` para no
 * mover el contrato del buzón.
 */
export interface DteLeido extends DteRecibido {
  rznSocRecep: string | null;
  subTotales: SubtotalInformativoLeido[];
}

export interface EnvioRecibido {
  /** sha256 hex del archivo completo, tal como llegó. */
  sha256: string;
  codificacion: Codificacion;
  /** `null` si lo que llegó fue un `<DTE>` suelto, sin sobre. */
  caratula: CaratulaRecibida | null;
  /** `ID` del `<SetDTE>`: es el `EnvioDTEID` que exige el acuse del envío. */
  setDteId: string | null;
  /**
   * `DigestValue` de la firma DEL SOBRE: el que está después del último `</SetDTE>`. Tomar el primero
   * del archivo daría el del `<Documento>`, y acusarle al proveedor un digest que no es el del envío.
   */
  digestSobre: string | null;
  dtes: DteRecibido[];
  /** `true` si el sobre traía más `<DTE>` que `opts.maxDtes`: se leyeron solo los primeros. */
  truncado: boolean;
}

/** Lo que C14N y cualquier lector XML resuelven en texto: las 5 entidades y las numéricas. */
export function desescaparXml(texto: string): string {
  return texto.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (ref, cuerpo: string) => {
    if (cuerpo[0] === "#") {
      const codigo = cuerpo[1] === "x" ? parseInt(cuerpo.slice(2), 16) : Number(cuerpo.slice(1));
      return codigo > 0x10ffff || (codigo >= 0xd800 && codigo <= 0xdfff) ? ref : String.fromCodePoint(codigo);
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[cuerpo];
  });
}

/**
 * Contenido interno del PRIMER elemento `tag` dentro de `xml`, sin tocar. Lineal (`core/xml-lineal`):
 * un regex perezoso aquí era cuadrático con aperturas sin cierre, y este texto lo manda cualquiera.
 */
export function bloque(xml: string, tag: string): string | null {
  return contenidoDe(xml, tag, "estricta");
}

/**
 * El `ID` de la primera apertura `<SetDTE …>`, leído sólo dentro de esa etiqueta (no exige el cierre,
 * igual que el regex que reemplaza). Lineal: un `indexOf` de la apertura y uno del `>`.
 */
function idSetDte(xml: string): string | null {
  let i = xml.indexOf("<SetDTE");
  while (i !== -1 && /[A-Za-z0-9_]/.test(xml.charAt(i + 7))) i = xml.indexOf("<SetDTE", i + 1);
  if (i === -1) return null;
  const gt = xml.indexOf(">", i);
  const etiqueta = xml.slice(i, gt === -1 ? undefined : gt);
  return /\sID\s*=\s*["']([^"']{1,80})["']/.exec(etiqueta)?.[1] ?? null;
}

/** Valor de texto de un campo simple, desescapado y recortado. `null` si no está o viene vacío. */
export function campo(xml: string, tag: string): string | null {
  const v = bloque(xml, tag);
  if (v === null) return null;
  const t = desescaparXml(v).trim();
  return t === "" ? null : t;
}

/** Cabecera `<?xml … encoding="…"?>`: el SII exige ISO-8859-1, pero se respeta si declara UTF-8. */
function codificacionDeclarada(cabeza: string): Codificacion {
  return /^\s*<\?xml[^>]*encoding\s*=\s*["']utf-?8["']/i.test(cabeza) ? "utf8" : "latin1";
}

// Construido con su código y no como literal: un BOM invisible en el fuente se pierde al editar.
const BOM = String.fromCharCode(0xfeff);

function decodificar(entrada: string | Buffer): { xml: string; codificacion: Codificacion; bytes: Buffer } {
  if (typeof entrada === "string") {
    const xml = entrada.startsWith(BOM) ? entrada.slice(1) : entrada;
    const codificacion = codificacionDeclarada(xml);
    return { xml, codificacion, bytes: Buffer.from(xml, codificacion) };
  }
  const conBom = entrada[0] === 0xef && entrada[1] === 0xbb && entrada[2] === 0xbf;
  const cuerpo = conBom ? entrada.subarray(3) : entrada;
  if (conBom || codificacionDeclarada(cuerpo.subarray(0, 200).toString("latin1")) === "utf8") {
    try {
      return { xml: new TextDecoder("utf-8", { fatal: true }).decode(cuerpo), codificacion: "utf8", bytes: entrada };
    } catch {
      // Declara UTF-8 y no lo es: se lee byte a byte (Latin-1 es biyectivo), sin perder nada.
    }
  }
  return { xml: cuerpo.toString("latin1"), codificacion: "latin1", bytes: entrada };
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Lee un envío recibido y devuelve su carátula y TODOS sus `<DTE>`.
 *
 * Tira `RecepcionInvalidaError` sólo cuando el archivo entero no sirve (vacío, gigante, con DTD o
 * sin ningún `<DTE>`). Un documento mal armado dentro de un sobre válido no tumba a sus hermanos:
 * sale con sus `problemas` y queda en rechazo local.
 *
 * `opts.maxDtes` corta la lectura ANTES de parsear: 8 MB de `<DTE></DTE>` son ~760.000 documentos
 * (medido en el review del buzón: 1,7 s y 1 GB). Lo usa el buzón de intercambio, donde escribe
 * cualquiera; la carga manual de un export (`importadores/archivo-dte`) puede traer miles.
 */
export function parsearEnvioDte(entrada: string | Buffer, opts: { maxDtes?: number } = {}): EnvioRecibido {
  const largo = entrada.length;
  if (largo === 0) throw new RecepcionInvalidaError("VACIO", "El archivo viene vacío.");
  if (largo > MAX_BYTES_ENVIO) {
    throw new RecepcionInvalidaError(
      "DEMASIADO_GRANDE",
      `El archivo supera el tope de ${MAX_BYTES_ENVIO / 1024 / 1024} MB: no es un DTE.`,
    );
  }
  const { xml, codificacion, bytes } = decodificar(entrada);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new RecepcionInvalidaError(
      "DTD_PROHIBIDO",
      "El XML declara un DOCTYPE o entidades: un DTE del SII no los usa y no se procesa.",
    );
  }

  const max = opts.maxDtes ?? Infinity;
  const encontrados = elementos(xml, "DTE", "palabra", max + 1);
  const truncado = encontrados.length > max;
  const dtes = encontrados.slice(0, max).map((e) => parsearDte(xml.slice(e.inicio, e.fin), codificacion));
  if (dtes.length === 0) {
    throw new RecepcionInvalidaError("SIN_DTE", "El archivo no contiene ningún <DTE>.");
  }

  const car = bloque(xml, "Caratula");
  const finSet = xml.lastIndexOf("</SetDTE>");
  return {
    sha256: sha256(bytes),
    codificacion,
    caratula: car === null
      ? null
      : {
          rutEmisor: campo(car, "RutEmisor"),
          rutEnvia: campo(car, "RutEnvia"),
          rutReceptor: campo(car, "RutReceptor"),
          fchResol: campo(car, "FchResol"),
          nroResol: campo(car, "NroResol"),
          tmstFirmaEnv: campo(car, "TmstFirmaEnv"),
        },
    setDteId: idSetDte(xml),
    digestSobre:
      finSet < 0 ? null : (/<DigestValue>\s*([^<\s]{1,120})\s*<\/DigestValue>/.exec(xml.slice(finSet))?.[1] ?? null),
    dtes,
    truncado,
  };
}

/**
 * Lee UN documento firmado tal como se custodia en `dte_emissions.xml_firmado`: un `<DTE>` suelto
 * (con o sin cabecera `<?xml?>`), o un sobre del que se toma el primero. Es el mismo lector del buzón:
 * los totales de lo emitido y de lo recibido se leen con una sola regla.
 *
 * No tira: un archivo que no se puede leer vuelve con `problemas`, y quien llama decide (el libro de
 * ventas lo manda a Observaciones en vez de sumarlo).
 */
export function parsearDteFirmado(entrada: Buffer | string): DteLeido {
  const { xml, codificacion } = decodificar(entrada);
  const vacio = xml.trim() === "";
  const dtd = /<!DOCTYPE|<!ENTITY/i.test(xml);
  const dte = vacio || dtd ? null : elemento(xml, "DTE", "palabra");
  if (!dte) {
    // Sólo la causa raíz: los "falta <Folio>" de parsear la nada contradicen al primer motivo y
    // terminan en la hoja Observaciones del libro de ventas.
    const leido = parsearDte("", codificacion);
    leido.problemas = [
      vacio ? "el archivo viene vacío" : dtd ? "el XML declara un DOCTYPE o entidades" : "el archivo no contiene ningún <DTE>",
    ];
    return leido;
  }
  return parsearDte(xml.slice(dte.inicio, dte.fin), codificacion);
}

function parsearDte(xml: string, codificacion: Codificacion): DteLeido {
  const problemas: string[] = [];
  // El DTE trae uno de tres contenidos (DTE_v10.xsd): factura y afines, liquidación o exportación.
  // El que aparece primero gana, como en la alternativa del regex que esto reemplaza.
  const candidato = (["Documento", "Liquidacion", "Exportaciones"] as const)
    .map((t) => elemento(xml, t))
    .filter((e) => e !== null)
    .sort((a, b) => a.inicio - b.inicio)[0];
  const documento = candidato ? xml.slice(candidato.contenidoInicio, candidato.contenidoFin) : "";
  if (!documento) problemas.push("el <DTE> no trae <Documento>");
  const encabezado = bloque(documento, "Encabezado") ?? "";
  const idDoc = bloque(encabezado, "IdDoc") ?? "";
  const emisor = bloque(encabezado, "Emisor") ?? "";
  const receptor = bloque(encabezado, "Receptor") ?? "";
  const totales = bloque(encabezado, "Totales") ?? "";

  const entero = (alcance: string, tag: string): number | null => {
    const v = campo(alcance, tag);
    if (v === null) return null;
    if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(Number(v))) {
      problemas.push(`<${tag}> no es un entero: "${v.slice(0, 40)}"`);
      return null;
    }
    return Number(v);
  };
  const rut = (alcance: string, tag: string): string => {
    const v = campo(alcance, tag) ?? "";
    const sii = rutSii(v);
    if (!sii) problemas.push(`<${tag}> no es un RUT válido: "${v.slice(0, 20)}"`);
    return sii || v;
  };

  const tipoDte = entero(idDoc, "TipoDTE");
  const folio = entero(idDoc, "Folio");
  if (tipoDte === null) problemas.push("falta <TipoDTE>");
  if (folio === null) problemas.push("falta <Folio>");

  const interior = (xml: string, tag: string) =>
    elementos(xml, tag, "exacta").map((e) => xml.slice(e.contenidoInicio, e.contenidoFin));
  const imptoReten = interior(totales, "ImptoReten").flatMap(
    (imp): ImpuestoRecibido[] => {
      const codigo = entero(imp, "TipoImp");
      const monto = entero(imp, "MontoImp");
      if (codigo === null || monto === null) {
        problemas.push("un <ImptoReten> viene sin código o sin monto");
        return [];
      }
      const tasa = campo(imp, "TasaImp");
      return [{ codigo, tasa: tasa === null ? null : Number(tasa), monto }];
    },
  );

  const referencias = interior(documento, "Referencia").map(
    (r): ReferenciaRecibida => ({
      tpoDocRef: campo(r, "TpoDocRef"),
      folioRef: campo(r, "FolioRef"),
      fchRef: campo(r, "FchRef"),
      codRef: entero(r, "CodRef"),
      razonRef: campo(r, "RazonRef"),
    }),
  );

  // Sin `entero()`: un subtotal informativo mal escrito NO puede sumar un problema, porque eso
  // cambiaría qué documentos rechaza el buzón. Quien los usa (el libro de ventas) trata el `null`.
  const subTotales = interior(documento, "SubTotInfo").map((st): SubtotalInformativoLeido => {
    const v = campo(st, "SubTotAdicSTI");
    return {
      glosa: campo(st, "GlosaSTI"),
      adicional: v !== null && /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null,
    };
  });

  return {
    tipoDte,
    folio,
    fchEmis: campo(idDoc, "FchEmis"),
    rutEmisor: rut(emisor, "RUTEmisor"),
    // La boleta nombra distinto a la razón social y al giro (ver core/boleta-xml.ts).
    rznSoc: campo(emisor, "RznSoc") ?? campo(emisor, "RznSocEmisor"),
    giroEmis: campo(emisor, "GiroEmis") ?? campo(emisor, "GiroEmisor"),
    rutRecep: rut(receptor, "RUTRecep"),
    rznSocRecep: campo(receptor, "RznSocRecep"),
    mntNeto: entero(totales, "MntNeto"),
    mntExe: entero(totales, "MntExe"),
    iva: entero(totales, "IVA"),
    imptoReten,
    credEc: entero(totales, "CredEC"),
    grntDep: entero(totales, "GrntDep"),
    valComNeto: entero(totales, "ValComNeto"),
    valComExe: entero(totales, "ValComExe"),
    valComIva: entero(totales, "ValComIVA"),
    mntTotal: entero(totales, "MntTotal"),
    referencias,
    subTotales,
    xml,
    sha256: sha256(Buffer.from(xml, codificacion)),
    codificacion,
    problemas,
  };
}

/**
 * Clave de deduplicación de un documento recibido: (RUT del emisor, tipo, folio). Es lo que el SII
 * considera "el mismo documento", así que un reenvío del proveedor cae en la misma clave aunque el
 * sobre sea otro. El RUT se normaliza: `76.086.428-5` y `76086428-5` son el mismo emisor.
 */
export function claveDedupRecibido(rutEmisor: string, tipoDte: number, folio: number): string {
  return `${rutSii(rutEmisor) || cleanRut(rutEmisor)}|${tipoDte}|${folio}`;
}

/**
 * ¿El `MntTotal` es la suma de sus partes?
 *
 * La regla es la del campo 124 de `docs/formato_dte_pdf.md:513`:
 *
 *   MntTotal = MntNeto + MntExe + IVA + Σ adicionales − Σ retenciones − CredEC + GrntDep
 *              − ValComNeto − ValComExe − ValComIVA
 *
 * Es la misma para todos los tipos: en la exenta (34) no hay neto ni IVA, en la boleta no hay
 * `ImptoReten` (el ILA va informativo) y las comisiones sólo existen en la liquidación factura.
 * Importa en la factura de un proveedor de licores: el ILA (24-27) SUMA, no es informativo como en
 * la boleta, y quien no lo suma rechazaría facturas buenas.
 *
 * No se recalcula el IVA contra la tasa: hay emisores que lo redondean por línea y otros sobre el
 * neto, y el SII acepta los dos. Eso lo confirma el SII, no esta red.
 */
export function revisarTotales(dte: DteRecibido): string[] {
  if (dte.mntTotal === null) return ["el documento no declara <MntTotal>"];
  const problemas: string[] = [];
  // Códigos y signo: la tabla §4 del SII, compartida con la emisión (core/dte-impuestos.ts).
  const { adicionales, retenciones, desconocidos } = clasificarImpuestos(dte.imptoReten);
  if (desconocidos.length > 0) {
    return desconocidos.map((codigo) => `el impuesto código ${codigo} no está en la tabla del SII: no se puede cuadrar el total`);
  }

  const n = (v: number | null) => v ?? 0;
  const esperado =
    n(dte.mntNeto) + n(dte.mntExe) + n(dte.iva) + adicionales - retenciones - n(dte.credEc) +
    n(dte.grntDep) - n(dte.valComNeto) - n(dte.valComExe) - n(dte.valComIva);
  if (esperado !== dte.mntTotal) {
    problemas.push(
      `MntTotal ${dte.mntTotal} no cuadra con sus partes (neto ${n(dte.mntNeto)} + exento ` +
        `${n(dte.mntExe)} + IVA ${n(dte.iva)} + adicionales ${adicionales} − retenciones ` +
        `${retenciones} = ${esperado})`,
    );
  }
  return problemas;
}

const OFFSET_SANTIAGO = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Santiago",
  timeZoneName: "longOffset",
});

/** Minutos de diferencia de Santiago con UTC en ese instante (−180 en verano, −240 en invierno). */
function offsetSantiago(utcMs: number): number {
  const nombre = OFFSET_SANTIAGO.formatToParts(new Date(utcMs)).find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(nombre ?? "");
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/**
 * La fecha en que el SII recibió el documento, de la respuesta de `consultarFechaRecepcionSii`.
 *
 * Es el reloj de los 8 días para reclamar (Ley 19.983): corre desde la recepción EN EL SII, no desde
 * la emisión ni desde que llegó el correo (R6/R19). El SII la devuelve como
 * `<return>21-02-2017 19:02:03</return>` (dd-mm-aaaa hh:mm:ss, hora de Chile). La versión de
 * api-facturacion buscaba `fechaRecepcion` o una fecha ISO y por eso devolvía SIEMPRE `null`: el
 * plazo se estimaba desde la emisión sin que nadie lo notara.
 *
 * Devuelve ISO 8601 CON el offset de Santiago de ese día (`2017-02-21T19:02:03-03:00`), para que
 * `new Date(...)` dé el instante correcto en un contenedor que corre en UTC. `null` si no viene una
 * fecha válida: inventarla sería calcular un plazo falso.
 */
export function parsearFechaRecepcionSii(respuestaXml: string): string | null {
  const m =
    /<(?:[\w.-]+:)?return>\s*(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*<\/(?:[\w.-]+:)?return>/.exec(
      respuestaXml,
    );
  if (!m) return null;
  const [, dd, mm, aaaa, hh, mi, ss] = m;
  const local = Date.UTC(+aaaa, +mm - 1, +dd, +hh, +mi, +ss);
  const d = new Date(local);
  // Date.UTC "corrige" un 31-02 al 03-03: si no vuelve igual, la fecha no existía.
  if (d.getUTCDate() !== +dd || d.getUTCMonth() !== +mm - 1 || d.getUTCHours() !== +hh) return null;

  // El offset depende del instante, que depende del offset: dos pasadas resuelven el cambio de hora.
  let offset = offsetSantiago(local);
  offset = offsetSantiago(local - offset * 60_000);
  const signo = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hhmm = `${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${aaaa}-${mm}-${dd}T${hh}:${mi}:${ss}${signo}${hhmm}`;
}
