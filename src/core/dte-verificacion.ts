import { X509Certificate, createHash, createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { canonicalizar, normalizarDocumentoAjeno } from "./dte-firma";
import { revisarTotales, desescaparXml, type DteRecibido } from "./dte-recepcion";
import { verificarFirmaTed } from "./dte-ted";
import { rutSii } from "./rut";
import { bloqueDe, contenidoDe, elemento, elementos } from "./xml-lineal";

/**
 * Verificación criptográfica LOCAL de un DTE recibido (R6 de `docs/PLAN-MIGRACION-CHONCHI.md`).
 *
 * ## Por qué cuatro pruebas y no una
 *
 * Un XML que llega por correo no prueba nada por sí solo: cualquiera puede escribir uno coherente
 * consigo mismo. Cada prueba cubre un hueco distinto:
 *
 * | Prueba | Qué prueba | Qué NO prueba |
 * |---|---|---|
 * | FRMA del CAF contra la llave del SII (IDK) | que el SII autorizó ese rango de folios a ese RUT | nada del documento |
 * | FRMT del TED con la RSAPK del CAF | que el timbre lo hizo quien tiene la llave privada del CAF | los montos fuera del `<DD>` |
 * | `<DD>` contra el encabezado | que el timbre es DE este documento y no uno pegado de otro | — |
 * | XML-DSig del `<Documento>` | que nada cambió después de firmar (neto, IVA, detalle, referencias) | QUIÉN firmó: el certificado viaja adentro y podría ser de cualquiera |
 *
 * Juntas: el folio es real y del emisor, el timbre es suyo y corresponde a este documento, y el
 * contenido no se tocó desde que alguien lo firmó. Lo que queda abierto (un tercero que re-firma
 * con su propio certificado cambiando el IVA pero no el total) lo cierra la consulta al SII, que
 * es la fuente de verdad: por eso un documento que pasa todo esto queda "sin verificar SII", no
 * "verificado".
 *
 * Una sola falla ⇒ "rechazado local": sin cuenta por pagar, sin aceptar, sin vínculo a la OC.
 *
 * ## La firma del documento: qué se digiere
 *
 * Las mismas dos reglas que `core/dte-firma.ts` aprendió con rechazos del SII:
 *
 * - El digest es sobre la forma canónica, que es **UTF-8** aunque el archivo viaje en ISO-8859-1
 *   (C14N §2.3). Con un documento ASCII las dos codificaciones coinciden y el error no se ve; con
 *   una Ñ no (RFR de las boletas 10008 y 10012).
 * - C14N **expande** en el texto `&quot;`, `&apos;` y las referencias numéricas.
 *
 * Por eso se canonicaliza con `canonicalizar` de `dte-firma`, el mismo código que firma: si las dos
 * mitades divergen, el test de ida y vuelta lo atrapa.
 *
 * Y una tercera, que no está en el firmador porque allá el contexto lo ponemos nosotros: **en qué
 * contexto de namespaces se firmó**. El SII, el motor Factronica y Kiubo digieren el `<Documento>`
 * SUELTO, sin el `xmlns` que hereda del `<SetDTE>` (un C14N inclusivo estricto dentro del sobre
 * falla incluso con boletas que el SII aceptó; memoria `nc61-castro-revision-2026-09-30`). Otros
 * emisores firman el `<DTE>` con su `xmlns` y lo quitan al ensobrar, o firman dentro del sobre. Se
 * prueban esos contextos (`CONTEXTOS`); no debilita nada, porque sólo varían las declaraciones de
 * namespace del nodo ápice: un monto cambiado no verifica en ninguno.
 *
 * Dominio puro: no toca red, disco ni base de datos.
 */

const NS_SII = "http://www.sii.cl/SiiDte";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const ALG_C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ALG_RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const ALG_SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
const ALG_ENVELOPED = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";

export type ResultadoVerificacion =
  | { estado: "ok" }
  | { estado: "falla"; motivo: string }
  /** Ni pasa ni falla: falta la llave pública del SII con que se verifica la FRMA. */
  | { estado: "sin_llave"; motivo: string };

const OK: ResultadoVerificacion = { estado: "ok" };
const falla = (motivo: string): ResultadoVerificacion => ({ estado: "falla", motivo });

/**
 * ⚠⚠⚠ LLAVE DEL SII PENDIENTE: copiar desde la fuente oficial. ⚠⚠⚠
 *
 * Llaves públicas con que el SII firma la `<FRMA>` de los CAF, por `<IDK>`: **100 = certificación
 * (maullin), 300 = PRODUCCIÓN (palena)** — al revés de la intuición (memoria `caf-idk-ambiente`).
 *
 * Están en `null` porque NO se encontraron en disco (se buscó en factronica-dte-server,
 * api-facturacion, node_modules y docs/) y una llave del SII no se escribe de memoria: una llave
 * equivocada rechaza todas las facturas buenas, y una inventada no prueba nada. Mientras estén en
 * `null`, `verificarCaf` devuelve `sin_llave` (ni pasa ni falla) y el llamador decide.
 *
 * Para completarlas: bajar los certificados públicos del SII para IDK 100 y 300 de una fuente
 * verificable (LibreDTE los distribuye como `certs/100.cer` y `certs/300.cer`, seriales 0x64 y
 * 0x12C), comparar su huella contra una segunda fuente, pegarlos en PEM aquí y verificar con un CAF
 * real de cada ambiente (el de producción de 77840802-3 debe validar contra 300).
 */
export const LLAVES_PUBLICAS_SII: Readonly<Record<string, string | null>> = {
  "100": null,
  "300": null,
};

export type AmbienteSii = "certificacion" | "produccion";

/** El `<IDK>` que corresponde a cada ambiente. Un CAF de certificación no vale en producción. */
export const IDK_POR_AMBIENTE: Readonly<Record<AmbienteSii, string>> = {
  certificacion: "100",
  produccion: "300",
};

// ── Forma canónica de un elemento recibido ─────────────────────────────────────────────────────

/**
 * Contextos de namespace en que un emisor puede haber firmado. El primero es el del SII.
 * Para el `<SignedInfo>` se combinan con las declaraciones de su propio `<Signature>`.
 */
const CONTEXTOS: ReadonlyArray<Readonly<Record<string, string>>> = [
  {},
  { "": NS_SII },
  { "": NS_SII, xsi: NS_XSI },
  { xsi: NS_XSI },
];

const ETIQUETA = /<([A-Za-z_][\w.:-]*)((?:\s+[^\s=<>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*>/g;
const ATRIBUTO = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Escapado C14N de un valor de atributo (§2.3): `&`, `<`, `"` y los blancos como referencia. */
function escaparAtributoC14n(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#x9;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;");
}

/**
 * Reescribe una etiqueta de apertura en forma canónica: comillas dobles, un espacio, primero los
 * namespaces (el default antes que los prefijos) y después los atributos ordenados. `nsExtra` son
 * los namespaces heredados que C14N agrega al nodo ápice; las declaraciones propias ganan.
 */
function etiquetaCanonica(nombre: string, atributos: string, nsExtra: Readonly<Record<string, string>>): string {
  const ns = new Map(Object.entries(nsExtra));
  const attrs: Array<{ clave: string; texto: string }> = [];
  for (const [, n, comillaDoble, comillaSimple] of atributos.matchAll(ATRIBUTO)) {
    // Normalización del parser (blancos literales → espacio) ANTES de resolver referencias.
    const valor = escaparAtributoC14n(desescaparXml((comillaDoble ?? comillaSimple).replace(/[\t\n\r]/g, " ")));
    if (n === "xmlns") ns.set("", valor);
    else if (n.startsWith("xmlns:")) ns.set(n.slice(6), valor);
    else attrs.push({ clave: n, texto: ` ${n}="${valor}"` });
  }
  // Atributos: sin prefijo primero (URI vacía), después por URI del prefijo y nombre local.
  const orden = (a: string) => {
    const [prefijo, local] = a.split(":");
    return local === undefined ? `0${a}` : `1${ns.get(prefijo) ?? prefijo} ${local}`;
  };
  attrs.sort((a, b) => (orden(a.clave) < orden(b.clave) ? -1 : 1));
  const declaraciones = [...ns]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([p, uri]) => (p === "" ? ` xmlns="${uri}"` : ` xmlns:${p}="${uri}"`))
    .join("");
  return `<${nombre}${declaraciones}${attrs.map((a) => a.texto).join("")}>`;
}

/**
 * Bytes canónicos (UTF-8) de un elemento tal como llegó, en el contexto de namespaces `nsExtra`.
 * Lo que `canonicalizar` no hace porque el firmador no lo necesita (etiquetas no canónicas, contexto
 * heredado) se resuelve aquí; el resto —fin de línea, referencias en texto, UTF-8— es el mismo código.
 */
function formaCanonica(elemento: string, nsExtra: Readonly<Record<string, string>>): Buffer {
  let apice = true;
  const normalizado = normalizarDocumentoAjeno(elemento)
    .replace(/<\/([A-Za-z_][\w.:-]*)\s+>/g, "</$1>")
    .replace(ETIQUETA, (_m, nombre: string, atributos: string) => {
      const etiqueta = etiquetaCanonica(nombre, atributos, apice ? nsExtra : {});
      apice = false;
      return etiqueta;
    });
  return canonicalizar(normalizado);
}

// ── XML-DSig ───────────────────────────────────────────────────────────────────────────────────

const algoritmo = (xml: string, tag: string): string | null =>
  new RegExp(`<${tag}\\b[^>]*\\sAlgorithm\\s*=\\s*["']([^"']+)["']`).exec(xml)?.[1] ?? null;
// Lineal (`core/xml-lineal`), mismo resultado que `<tag\b[^>]*>([\s\S]*?)</tag>`: corre sobre DTE recibidos.
const contenido = (xml: string, tag: string): string | null => contenidoDe(xml, tag);
const sinBlancos = (s: string) => s.replace(/\s+/g, "");

/**
 * Verifica una firma XML-DSig (`<Signature>` completo) sobre el elemento que referencia por `ID`.
 *
 * Sólo lo que el SII admite (`xmldsignature_v10.xsd`): C14N inclusivo, RSA-SHA1, SHA-1 y como
 * transformadas `enveloped-signature` o el mismo C14N inclusivo. Cualquier otro algoritmo es falla,
 * no "no sé": un emisor del SII no puede usarlo, así que su presencia ya es una señal.
 *
 * La transformada C14N se admite porque emisores reales la usan: 4 de 6 facturas recibidas en el
 * buzón de Belén la declaraban, y el SII las tiene como DOK (prueba en vivo del 2026-10-26). No
 * cambia el digest: es la misma canonicalización que se aplica siempre; y `enveloped-signature` no
 * aplica a un `<Documento>` cuya firma va afuera. `#WithComments` (una NC 61 real del mismo buzón)
 * sólo difiere si hay comentarios: se admite cuando el elemento firmado no tiene ninguno.
 */
export function verificarFirmaXml(elementoXml: string, firmaXml: string): ResultadoVerificacion {
  if (/^<\w+:Signature\b/.test(firmaXml.trimStart())) {
    // ponytail: firma con prefijo (ds:) no soportada; agregar si un emisor real la usa.
    return falla("la firma usa un prefijo de namespace (ds:) que no se soporta: revisar a mano");
  }
  const id = /^<[\w.:-]+\b[^>]*\sID\s*=\s*["']([^"']*)["']/.exec(elementoXml)?.[1];
  const signedInfo = /<SignedInfo\b[^>]*>[\s\S]*?<\/SignedInfo>/.exec(firmaXml)?.[0];
  const digestValue = contenido(firmaXml, "DigestValue");
  const signatureValue = contenido(firmaXml, "SignatureValue");
  const x509 = contenido(firmaXml, "X509Certificate");
  if (!signedInfo || !digestValue || !signatureValue) {
    return falla("la firma está incompleta (falta SignedInfo, DigestValue o SignatureValue)");
  }

  const uri = /<Reference\b[^>]*\sURI\s*=\s*["']([^"']*)["']/.exec(signedInfo)?.[1];
  if (!id || uri !== `#${id}`) {
    return falla(`la firma referencia "${uri ?? ""}" y el elemento firmado es "#${id ?? ""}"`);
  }
  const transformadas = [...signedInfo.matchAll(/<Transform\b[^>]*\sAlgorithm\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const algoritmos = {
    canonicalizacion: algoritmo(signedInfo, "CanonicalizationMethod"),
    firma: algoritmo(signedInfo, "SignatureMethod"),
    digest: algoritmo(signedInfo, "DigestMethod"),
  };
  if (
    algoritmos.canonicalizacion !== ALG_C14N ||
    algoritmos.firma !== ALG_RSA_SHA1 ||
    algoritmos.digest !== ALG_SHA1 ||
    transformadas.some((t) => t !== ALG_ENVELOPED && t !== ALG_C14N && !(t === `${ALG_C14N}#WithComments` && !elementoXml.includes("<!--")))
  ) {
    return falla(`la firma usa algoritmos que el SII no admite: ${JSON.stringify({ ...algoritmos, transformadas })}`);
  }

  // La llave sale del certificado; si no se puede leer, del <RSAKeyValue> que el SII exige al
  // lado. Las dos son igual de autodeclaradas (la firma prueba integridad, no identidad), así que
  // aceptar la segunda no abre nada.
  let llave: KeyObject;
  try {
    llave = new X509Certificate(Buffer.from(sinBlancos(x509 ?? ""), "base64")).publicKey;
  } catch (e) {
    const modulus = contenido(firmaXml, "Modulus");
    const exponent = contenido(firmaXml, "Exponent");
    try {
      if (!modulus || !exponent) throw e;
      const url = (b64: string) => Buffer.from(sinBlancos(b64), "base64").toString("base64url");
      llave = createPublicKey({ key: { kty: "RSA", n: url(modulus), e: url(exponent) }, format: "jwk" });
    } catch {
      return falla(`la firma no trae una llave legible (X509Certificate ni RSAKeyValue): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 1) El digest: ¿el contenido es el que se firmó?
  const esperado = sinBlancos(digestValue);
  const errores: string[] = [];
  const digestCoincide = CONTEXTOS.some((ctx) => {
    try {
      return createHash("sha1").update(formaCanonica(elementoXml, ctx)).digest("base64") === esperado;
    } catch (e) {
      errores.push(e instanceof Error ? e.message : String(e));
      return false;
    }
  });
  if (!digestCoincide) {
    // Sólo se culpa a la canonicalización si no se pudo en NINGÚN contexto.
    return falla(
      errores.length === CONTEXTOS.length
        ? `no se pudo canonicalizar el elemento firmado: ${errores[0]}`
        : "el DigestValue no corresponde al contenido: el documento cambió después de firmarse",
    );
  }

  // 2) La firma: ¿ese digest lo firmó la llave del certificado? El <SignedInfo> hereda los
  //    namespaces de su <Signature> más los del contexto.
  const propios = Object.fromEntries(
    [...(/^<Signature\b([^>]*)>/.exec(firmaXml.trimStart())?.[1] ?? "").matchAll(/\sxmlns(?::([\w.-]+))?\s*=\s*["']([^"']*)["']/g)].map(
      (m) => [m[1] ?? "", m[2]],
    ),
  );
  const firma = Buffer.from(sinBlancos(signatureValue), "base64");
  const vistos = new Set<string>();
  for (const ctx of CONTEXTOS) {
    const nsSignedInfo = { ...ctx, ...propios };
    const clave = JSON.stringify(Object.entries(nsSignedInfo).sort());
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    try {
      const verificador = createVerify("RSA-SHA1");
      verificador.update(formaCanonica(signedInfo, nsSignedInfo));
      if (verificador.verify(llave, firma)) return OK;
    } catch {
      // Un SignedInfo que no canonicaliza simplemente no verifica en ese contexto.
    }
  }
  return falla("la SignatureValue no corresponde al SignedInfo y al certificado que trae la firma");
}

/**
 * XML-DSig del `<Documento>` de un `<DTE>` recibido, con el certificado embebido en su firma.
 * Recibe el `<DTE>…</DTE>` crudo, como lo deja `parsearEnvioDte`.
 */
// ponytail: estos regex (Documento, Signature, SignedInfo y `algoritmo`) siguen perezosos, o sea
// cuadráticos con aperturas sin cierre. Hoy el buzón no los llama (solo verificarTimbre); pasarlos a
// core/xml-lineal ANTES de que la Ola 4 llame verificarDteRecibido sobre los correos de la casilla.
export function verificarFirmaDocumento(dteXml: string): ResultadoVerificacion {
  const doc = /<(Documento|Liquidacion|Exportaciones)\b[^>]*>[\s\S]*?<\/\1>/.exec(dteXml);
  if (!doc) return falla("el <DTE> no trae <Documento>");
  const despues = dteXml.slice(doc.index + doc[0].length);
  const firma = /<(?:\w+:)?Signature\b[^>]*>[\s\S]*?<\/(?:\w+:)?Signature>/.exec(despues)?.[0];
  if (!firma) return falla("el <DTE> no trae la firma del documento");
  return verificarFirmaXml(doc[0], firma);
}

// ── CAF y timbre ───────────────────────────────────────────────────────────────────────────────

/**
 * ¿La `<FRMA>` del CAF es del SII? Es la única prueba de que el rango de folios existe.
 *
 * El SII firma el nodo `<DA>…</DA>` APLANADO (sin blancos entre etiquetas, `>\s+<` → `><`) sobre
 * bytes Latin-1, con SHA1withRSA (memoria `caf-idk-ambiente`, verificado con el CAF 39 real de
 * 77840802-3 contra la llave 300). El CAF puede venir del archivo del SII (con saltos de línea) o
 * embebido en el `<DD>` de un TED (ya aplanado): aplanar cubre los dos.
 *
 * `llavePublicaSii` es la llave del `<IDK>` del CAF, en PEM (llave pública o certificado). Con
 * `null` devuelve `sin_llave`: ver `LLAVES_PUBLICAS_SII`.
 */
export function verificarCaf(cafXml: string, llavePublicaSii: string | KeyObject | null): ResultadoVerificacion {
  const caf = bloqueDe(cafXml, "CAF");
  if (!caf) return falla("no hay bloque <CAF>");
  // Un solo <DA> y una sola <FRMA>: la FRMA que se prueba tiene que ser la de ESE <DA>, el mismo cuya
  // <RSAPK> usa verificarFirmaTed.
  if (elementos(caf, "DA", "exacta", 2).length !== 1 || elementos(caf, "FRMA", "palabra", 2).length !== 1) {
    return falla("el CAF debe traer exactamente un <DA> y una <FRMA>");
  }
  const da = bloqueDe(caf, "DA", "exacta");
  const frma = contenido(caf, "FRMA");
  if (!da || !frma) return falla("el CAF no trae <DA> o <FRMA>");
  const idk = contenido(da, "IDK")?.trim() ?? "?";
  if (llavePublicaSii === null) {
    return { estado: "sin_llave", motivo: `no está cargada la llave pública del SII para el IDK ${idk}` };
  }
  try {
    const verificador = createVerify("RSA-SHA1");
    verificador.update(Buffer.from(da.replace(/>\s+</g, "><"), "latin1"));
    const llave = typeof llavePublicaSii === "string" ? createPublicKey(llavePublicaSii) : llavePublicaSii;
    return verificador.verify(llave, Buffer.from(sinBlancos(frma), "base64"))
      ? OK
      : falla(`la FRMA del CAF no es del SII (IDK ${idk}): el rango de folios no está autorizado`);
  } catch (e) {
    return falla(`no se pudo verificar la FRMA del CAF: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * El timbre: la `<FRMT>` con la `<RSAPK>` del CAF (reusa `verificarFirmaTed`) y, sobre todo, que el
 * `<DD>` sea de ESTE documento. Sin lo segundo, un falsificador pega el TED válido de una factura
 * real de $1.000 a un documento inventado de $1.000.000: el FRMT verificaría igual.
 *
 * La FRMT se prueba sobre el `<DD>` tal cual y, si no verifica, aplanado: así firman el SDK y
 * LibreDTE, y un emisor que lo guarda indentado sigue siendo válido (el contenido es el mismo).
 */
/** El `<DD>` del ÚNICO `<TED>` del documento, o `null` (sin timbre, o con más de un TED/DD). */
function ddDelTimbre(xml: string): string | null {
  return posicionDelDd(xml)?.dd ?? null;
}

/** El `<DD>` del único `<TED>` y dónde empieza en `xml` (para reemplazarlo ahí y no en otro lado). */
function posicionDelDd(xml: string): { dd: string; inicio: number } | null {
  const teds = elementos(xml, "TED", "palabra", 2);
  if (teds.length !== 1) return null;
  const ted = xml.slice(teds[0].inicio, teds[0].fin);
  const dds = elementos(ted, "DD", "exacta", 2);
  if (dds.length !== 1) return null;
  return { dd: ted.slice(dds[0].inicio, dds[0].fin), inicio: teds[0].inicio + dds[0].inicio };
}

export function verificarTimbre(dte: DteRecibido): ResultadoVerificacion {
  // El <DD> y su <CAF> se leen DENTRO del <TED>, igual que en verificarFirmaTed: con "el primero del
  // documento", un <DD> o un <DA> de adorno antes del timbre engañaría la comparación de campos.
  const pos = posicionDelDd(dte.xml);
  if (!pos) return falla("el documento no trae <TED>/<DD> (no está timbrado)");
  const { dd } = pos;

  let ted = verificarFirmaTed(dte.xml);
  // El reintento aplanado solo tiene sentido si hay blancos entre etiquetas, y se aplica sobre ESE
  // <DD> (por posición), no sobre la primera aparición del texto, que podría ser un adorno.
  if (!ted.valido && />\s+</.test(dd)) {
    const aplanado = dte.xml.slice(0, pos.inicio) + dd.replace(/>\s+</g, "><") + dte.xml.slice(pos.inicio + dd.length);
    const plano = verificarFirmaTed(aplanado);
    if (plano.valido) ted = plano;
  }
  if (!ted.valido) return falla(ted.motivo);

  const del = (xml: string, tag: string) => {
    const v = contenido(xml, tag);
    return v === null ? null : desescaparXml(v).trim();
  };
  const rut = (v: string | null) => (v === null ? null : rutSii(v) || v);
  const cafDelTed = bloqueDe(dd, "CAF");
  const da = (cafDelTed ? bloqueDe(cafDelTed, "DA", "exacta") : null) ?? "";
  const distintos: string[] = [];
  const comparar = (que: string, timbre: string | null, documento: string | number | null) => {
    if (timbre !== (documento === null ? null : String(documento))) {
      distintos.push(`${que} (timbre "${timbre ?? ""}", documento "${documento ?? ""}")`);
    }
  };
  // El <DD> trae el CAF adentro, que también tiene <RE>/<TD>: se lee sin él.
  const cafDelDd = elemento(dd, "CAF");
  const ddSinCaf = cafDelDd ? dd.slice(0, cafDelDd.inicio) + dd.slice(cafDelDd.fin) : dd;
  comparar("RUT emisor", rut(del(ddSinCaf, "RE")), dte.rutEmisor);
  comparar("tipo", del(ddSinCaf, "TD"), dte.tipoDte);
  comparar("folio", del(ddSinCaf, "F"), dte.folio);
  comparar("fecha de emisión", del(ddSinCaf, "FE"), dte.fchEmis);
  comparar("RUT receptor", rut(del(ddSinCaf, "RR")), dte.rutRecep);
  comparar("monto total", del(ddSinCaf, "MNT"), dte.mntTotal);
  comparar("RUT del CAF", rut(del(da, "RE")), dte.rutEmisor);
  comparar("tipo del CAF", del(da, "TD"), dte.tipoDte);
  const desde = Number(del(da, "D"));
  const hasta = Number(del(da, "H"));
  if (dte.folio === null || !(dte.folio >= desde && dte.folio <= hasta)) {
    distintos.push(`folio ${dte.folio ?? "?"} fuera del rango del CAF [${desde}, ${hasta}]`);
  }
  return distintos.length === 0
    ? OK
    : falla(`el timbre no corresponde a este documento: ${distintos.join("; ")}`);
}

// ── Todo junto ─────────────────────────────────────────────────────────────────────────────────

export interface VerificacionDte {
  /** `true` sólo si TODO verificó, incluida la FRMA del CAF contra la llave del SII. */
  ok: boolean;
  /** Fallas concretas. Con una sola, el documento queda "rechazado local" y sin efectos (R6). */
  problemas: string[];
  /**
   * La FRMA del CAF no se pudo verificar porque falta la llave del SII. No es falla ni pase: el
   * llamador NO debe tratarlo como verificado (ver `LLAVES_PUBLICAS_SII`).
   */
  sinLlaveSii: boolean;
}

/**
 * Las cuatro pruebas de R6 más los totales, sobre un `<DTE>` ya separado por `parsearEnvioDte`.
 *
 * `ambiente` es el del RECEPTOR: un documento de certificación (CAF con IDK 100) que le llega a un
 * emisor en producción no tiene valor tributario aunque todo lo demás verifique. `llavesSii`
 * reemplaza a `LLAVES_PUBLICAS_SII` (configuración o tests).
 *
 * No revisa que `RUTRecep` sea uno de nuestros emisores: eso es ruteo y lo hace el worker.
 */
export function verificarDteRecibido(
  dte: DteRecibido,
  opts: { ambiente: AmbienteSii; llavesSii?: Readonly<Record<string, string | KeyObject | null>> },
): VerificacionDte {
  const problemas = [...dte.problemas, ...revisarTotales(dte)];
  const anotar = (que: string, r: ResultadoVerificacion) => {
    if (r.estado === "falla") problemas.push(`${que}: ${r.motivo}`);
  };

  anotar("firma del documento", verificarFirmaDocumento(dte.xml));
  anotar("timbre", verificarTimbre(dte));

  let sinLlaveSii = false;
  // La FRMA del SII se prueba sobre el CAF DEL TIMBRE, el mismo cuya llave verificó la FRMT. Con "el
  // primer <CAF> del documento", un CAF real pegado (cualquier factura de un proveedor trae uno) daría
  // por verificado un timbre hecho con otra llave.
  const ddDelTed = ddDelTimbre(dte.xml);
  const cafDelTimbre = ddDelTed ? bloqueDe(ddDelTed, "CAF") : null;
  const da = cafDelTimbre ? contenidoDe(cafDelTimbre, "DA", "exacta") : null;
  const idk = da ? (contenido(da, "IDK")?.trim() ?? null) : null;
  const esperado = IDK_POR_AMBIENTE[opts.ambiente];
  if (!idk) {
    problemas.push("CAF: el timbre no trae el CAF o su <IDK>");
  } else if (idk !== esperado) {
    problemas.push(
      `CAF: es del IDK ${idk} y en ${opts.ambiente} corresponde el ${esperado} ` +
        "(100 = certificación, 300 = producción): el documento no tiene valor tributario para este receptor",
    );
  } else {
    const caf = verificarCaf(cafDelTimbre ?? "", (opts.llavesSii ?? LLAVES_PUBLICAS_SII)[idk] ?? null);
    if (caf.estado === "sin_llave") sinLlaveSii = true;
    anotar("CAF", caf);
  }

  return { ok: problemas.length === 0 && !sinLlaveSii, problemas, sinLlaveSii };
}
