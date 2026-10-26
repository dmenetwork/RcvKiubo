import { siiTimestamp } from "../fechas";
import {
  escaparTextoXml,
  firmarDocumento,
  normalizarDocumentoAjeno,
  type CertificadoFirmante,
} from "../dte-firma";

/**
 * Sobre de envío al SII: `<EnvioDTE>` para facturas y `<EnvioBOLETA>` para boletas.
 *
 * ## Por qué lo construye Kiubo y no el motor
 *
 * Dos razones independientes, y cada una alcanza:
 *
 * 1. **El motor sube siempre a palena.** `index.php:185` le pasa una constante a
 *    `class.uploadsii.php`, cuya URL sí es parámetro del constructor (`:28`). Con `SWENVIARSII=0`
 *    —que es como corre— el motor es una fábrica de documentos y la subida es nuestra. Para subir
 *    hay que armar el sobre.
 * 2. **El motor sólo sabe armar `<EnvioDTE>`** (`class.factronica.dte.php:163`). La boleta exige
 *    `<EnvioBOLETA>` con `EnvioBOLETA_v11.xsd`.
 *
 * O sea que esto hacía falta igual, con boleta o sin ella.
 *
 * ## La carátula es la misma en los dos esquemas
 *
 * Verificado contra `docs/dte-boleta/xsd/EnvioDTE_v10.xsd` y `EnvioBOLETA_v11.xsd`: los dos declaran
 * `RutEmisor, RutEnvia, RutReceptor, FchResol, NroResol, TmstFirmaEnv, SubTotDTE+`. Lo único que
 * cambia es el elemento raíz y el schema. Por eso una sola función sirve para los dos.
 *
 * Dominio puro: no toca red, disco ni base de datos.
 */

const NS_SII = "http://www.sii.cl/SiiDte";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";

/** Qué sobre corresponde: la boleta va en el suyo, todo lo demás en `<EnvioDTE>`. */
export type TipoSobre = "boleta" | "dte";

/**
 * Tope de boletas por envío que fija el SII.
 *
 * *"se ha establecido como límite para el envío de información **500 boletas por envío**, lo que
 * permite asegurar un óptimo procesamiento de la información tanto a los emisores como al SII"*
 * — Formato Boletas Electrónicas v4.00 §2 (`docs/dte-boleta/formato_boleta_pdf.md`).
 *
 * Importa para un supermercado: cientos de boletas al día significa que el envío diario puede pasarse
 * del tope y hay que partirlo en lotes. Se corta acá y no en el SII, porque allá el rechazo llega
 * sobre documentos ya emitidos y con folio quemado.
 *
 * Para `<EnvioDTE>` la especificación de factura **no declara un tope**; se buscó y no está. Por eso
 * no se inventa uno.
 */
export const MAX_BOLETAS_POR_ENVIO = 500;

/**
 * Renglón más largo que el parser del SII acepta en un envío.
 *
 * No está en ningún instructivo: es el límite del parser (Oracle) del lado del SII, y se conoce por
 * el rechazo que produce — `estado RSC`, detalle `CHR-00002: Line too long (4090)`. Lo confirmamos
 * en producción el 2026-08-28 (trackid 23516044422) con un sobre de 10,6 KB en un solo renglón.
 * LibreDTE evita el problema generando XML con saltos de línea; acá igual.
 */
export const MAX_LINEA_SII = 4090;

/**
 * Quita la declaración `<?xml …?>` (y un BOM si viniera) de un documento que va a embeberse en un
 * sobre: el sobre declara la suya una sola vez. El BOM se contempla en sus dos formas: el carácter
 * U+FEFF y los bytes `EF BB BF` leídos como Latin-1 (`ï»¿`), que es como llegan los archivos del
 * motor decodificados con `toString("latin1")`.
 */
const BOMS = [String.fromCharCode(0xfeff), String.fromCharCode(0xef, 0xbb, 0xbf)];

export function sinDeclaracionXml(xml: string): string {
  // Construidos con códigos, no con escapes ni literales: un BOM invisible en el fuente se pierde
  // con cualquier editor que normalice, y un `\u` puede quedar convertido al carácter.
  const bom = BOMS.find((b) => xml.startsWith(b));
  const sinBom = bom ? xml.slice(bom.length) : xml;
  return sinBom.replace(/^\s*<\?xml[^>]*\?>\s*/, "");
}

/** Parte un texto base64 en renglones de 76, como lo escriben los firmadores habituales. */
function envolverBase64(b64: string): string {
  const limpio = b64.replace(/\s+/g, "");
  return limpio.match(/.{1,76}/g)?.join("\n") ?? limpio;
}

/**
 * Le da renglones propios a la firma EXTERNA de un `EnvioDTE` que vino en un solo renglón (el
 * motor Factronica escribe `…</Documento><Signature/></DTE></SetDTE><Signature/></EnvioDTE>` de
 * corrido: 8.136 caracteres con certificados de 2048 bits → `RSC` del SII, palena 2026-09-30).
 *
 * Toca SOLO lo que ninguna firma cubre: el salto antes de la `<Signature>` del sobre queda fuera
 * del `<SetDTE>` (que es lo que esa firma digiere), y dentro de ella se parten `SignatureValue` y
 * `X509Certificate`, que son base64 (el blanco se ignora al decodificar) y no forman parte del
 * `SignedInfo`. El `SignedInfo` y todo el `<SetDTE>` —incluida la firma del DTE, que va adentro—
 * quedan byte a byte iguales. No re-firma nada. Idempotente.
 *
 * Es el RESPALDO (`emitirDte` lo custodia sólo si el DTE no pudo descargarse o el sobre propio no
 * pudo armarse): el renglón del `</SetDTE>` conserva la firma interna del DTE (~3.650 caracteres
 * con este certificado) y un certificado con cadena larga podría superar `MAX_LINEA_SII`. El camino
 * principal, `construirSobreDeDteAjeno`, arma el sobre acá y no tiene ese techo.
 */
export function desdoblarFirmaExternaDelSobre(xml: string): string {
  return desdoblarFirmaTras(xml, "</SetDTE>");
}

/**
 * Lo mismo para la firma del `<DTE>` del motor (la que sigue a `</Documento>`): el `SignedInfo` de
 * esa firma cubre sólo el `<Documento>`, así que partir su `SignatureValue`/`X509Certificate` no la
 * invalida. SOLO vale si el `<SetDTE>` que lo contiene lo firmamos NOSOTROS después
 * (`construirSobreDeDteAjeno`); dentro del sobre del motor ese DTE ya está digerido y no se toca.
 */
export function desdoblarFirmaDelDte(xml: string): string {
  return desdoblarFirmaTras(xml, "</Documento>");
}

/**
 * Arma NUESTRO `<EnvioDTE>` con un `<DTE>` firmado por el motor. Reemplaza al `_SET_SII.xml` del
 * motor, que trae las dos firmas y los cierres en un renglón de ~8.100 caracteres y el SII lo
 * rechaza por esquema (`RSC`, palena 2026-09-30). Acá el DTE entra con su firma desdoblada y el
 * sobre se firma con renglones cortos, igual que el de boletas que el SII ya acepta.
 */
export function construirSobreDeDteAjeno(
  xmlDte: string,
  tipoDte: number,
  caratula: CaratulaEnvio,
  certificado: CertificadoFirmante,
  ahora: Date,
): Buffer {
  // El tope de renglón lo aplica `construirSobre` para los dos tipos de sobre.
  return serializarSobre(
    [{ tipoDte, xml: desdoblarFirmaDelDte(sinDeclaracionXml(xmlDte)) }],
    caratula,
    certificado,
    ahora,
    "dte",
  );
}

function desdoblarFirmaTras(xml: string, etiquetaCierre: string): string {
  const cierre = xml.lastIndexOf(etiquetaCierre);
  if (cierre < 0) return xml;
  const desde = cierre + etiquetaCierre.length;
  const cola = xml.slice(desde);
  const firma = cola.indexOf("<Signature");
  if (firma < 0) return xml;

  // Las etiquetas se reconocen con atributos opcionales (`<SignatureValue Id="…">`) y TODOS los
  // certificados de la cadena se parten, no sólo el primero.
  let externa = cola.slice(firma);
  externa = externa
    .replace(/<\/SignedInfo>\s*<SignatureValue\b/, "</SignedInfo>\n<SignatureValue")
    .replace(/(<SignatureValue\b[^>]*>)([^<]*)<\/SignatureValue>/, (_m, abre: string, b64: string) =>
      `${abre}\n${envolverBase64(b64)}\n</SignatureValue>`)
    .replace(/<\/SignatureValue>\s*<KeyInfo\b/, "</SignatureValue>\n<KeyInfo")
    .replace(/(<X509Certificate\b[^>]*>)([^<]*)<\/X509Certificate>/g, (_m, abre: string, b64: string) =>
      `${abre}\n${envolverBase64(b64)}\n</X509Certificate>`);

  const previo = cola.slice(0, firma);
  const separador = /\n\s*$/.test(previo) ? "" : "\n";
  return xml.slice(0, desde) + previo + separador + externa;
}

const SOBRES: Record<TipoSobre, { raiz: string; schema: string }> = {
  boleta: { raiz: "EnvioBOLETA", schema: "EnvioBOLETA_v11.xsd" },
  dte: { raiz: "EnvioDTE", schema: "EnvioDTE_v10.xsd" },
};

export interface CaratulaEnvio {
  rutEmisor: string;
  /** RUT de la PERSONA dueña del certificado, no de la empresa. */
  rutEnvia: string;
  /** Constante del SII para el receptor del envío. */
  rutReceptor?: string;
  /** Fecha de la resolución que autoriza al contribuyente, `AAAA-MM-DD`. */
  fechaResolucion: string;
  /** Número de resolución. En certificación es `0`. */
  numeroResolucion: string;
}

/** Un documento ya firmado, con su tipo, para contarlo en la carátula. */
export interface DocumentoEnSobre {
  tipoDte: number;
  /** El `<DTE>…</DTE>` completo, firmado. */
  xml: string;
}

function tag(nombre: string, valor: string | number): string {
  return `<${nombre}>${escaparTextoXml(String(valor))}</${nombre}>`;
}

/**
 * Arma y firma el sobre.
 *
 * La carátula declara un `<SubTotDTE>` **por cada tipo** de documento que va adentro, con su
 * cantidad — el SII cuadra ese conteo contra el contenido y rechaza el envío entero si no coincide.
 * Por eso se cuenta acá y no se recibe como parámetro.
 */
export function construirSobre(
  documentos: DocumentoEnSobre[],
  caratula: CaratulaEnvio,
  certificado: CertificadoFirmante,
  ahora: Date,
  tipo: TipoSobre,
): string {
  if (documentos.length === 0) {
    throw new Error("Un envío sin documentos no tiene nada que declarar.");
  }
  if (tipo === "boleta" && documentos.length > MAX_BOLETAS_POR_ENVIO) {
    throw new Error(
      `El SII acepta ${MAX_BOLETAS_POR_ENVIO} boletas por envío como máximo y este trae ` +
        `${documentos.length}. Hay que partirlo en lotes.`,
    );
  }
  const { raiz, schema } = SOBRES[tipo];
  const idSet = "SetDte";

  // Conteo por tipo, en orden estable de aparición.
  const porTipo = new Map<number, number>();
  for (const d of documentos) porTipo.set(d.tipoDte, (porTipo.get(d.tipoDte) ?? 0) + 1);
  const subTotales = [...porTipo]
    .map(([t, n]) => `<SubTotDTE>${tag("TpoDTE", t)}${tag("NroDTE", n)}</SubTotDTE>`)
    .join("");

  // Las declaraciones de namespace van en el <SetDTE> porque es lo que se digiere suelto: al
  // canonicalizar un subárbol, el nodo ápice reemite los namespaces que tiene en alcance.
  //
  // Los `\n` entre bloques existen porque el parser del SII rechaza renglones de más de ~4.000
  // caracteres (`CHR-00002: Line too long (4090)`, verificado en producción 2026-08-28). Son texto
  // entre elementos, que C14N preserva: se insertan ANTES de firmar y el digest sigue siendo el de
  // la forma canónica.
  const setDte =
    `<SetDTE xmlns="${NS_SII}" xmlns:xsi="${NS_XSI}" ID="${idSet}">\n` +
    `<Caratula version="1.0">` +
    tag("RutEmisor", caratula.rutEmisor) +
    tag("RutEnvia", caratula.rutEnvia) +
    tag("RutReceptor", caratula.rutReceptor ?? "60803000-K") +
    tag("FchResol", caratula.fechaResolucion) +
    tag("NroResol", caratula.numeroResolucion) +
    tag("TmstFirmaEnv", siiTimestamp(ahora)) +
    subTotales +
    `</Caratula>\n` +
    // Los documentos se normalizan porque pueden venir de afuera: los que firma el motor traen el
    // <Signature> con etiquetas auto-cerradas, y el digest del <SetDTE> se calcula sobre el texto.
    documentos.map((d) => normalizarDocumentoAjeno(d.xml)).join("\n") +
    `\n</SetDTE>`;

  // El <SignedInfo> del sobre hereda el xmlns:xsi de la raíz; sin él la firma no valida.
  const firma = firmarDocumento(setDte, idSet, certificado, ` xmlns:xsi="${NS_XSI}"`);

  const sobre =
    `<${raiz} xmlns="${NS_SII}" xmlns:xsi="${NS_XSI}" version="1.0"` +
    ` xsi:schemaLocation="${NS_SII} ${schema}">\n` +
    setDte +
    `\n` +
    firma +
    `\n</${raiz}>`;

  // El tope rige para los DOS sobres: el SII lo impuso en boletas (RSC `CHR-00002`, 2026-08-28) y
  // en facturas/NC (RSC en palena 2026-09-30, sobre del motor con las firmas en un renglón). Acá el
  // sobre lo generamos entero nosotros, así que pasarse es un bug nuestro y se corta ANTES de subir.
  for (const renglon of sobre.split("\n")) {
    if (renglon.length > MAX_LINEA_SII) {
      throw new Error(
        `Un renglón del sobre mide ${renglon.length} caracteres y el SII rechaza los de más de ` +
          `${MAX_LINEA_SII} (RSC / CHR-00002). Es un bug del armado del XML: ` +
          `${renglon.slice(0, 80)}…`,
      );
    }
  }
  return sobre;
}

/** El sobre en los BYTES ISO-8859-1 que se suben al SII. */
export function serializarSobre(
  documentos: DocumentoEnSobre[],
  caratula: CaratulaEnvio,
  certificado: CertificadoFirmante,
  ahora: Date,
  tipo: TipoSobre,
): Buffer {
  const xml =
    `<?xml version="1.0" encoding="ISO-8859-1"?>\n` +
    construirSobre(documentos, caratula, certificado, ahora, tipo);
  return Buffer.from(xml, "latin1");
}
