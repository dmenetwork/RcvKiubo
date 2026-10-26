import { createHash, createSign } from "node:crypto";
import { normalizarLatin1 } from "./texto";

/**
 * Firma electrónica de un DTE: timbre (TED) y firma XML-DSig del documento.
 *
 * ## Por qué existe
 *
 * El motor de facturas de Factronica no puede emitir una boleta 39 válida: el `<Encabezado>` de la
 * boleta usa `<RznSocEmisor>`/`<GiroEmisor>` donde la factura usa `<RznSoc>`/`<GiroEmis>`, y esos
 * nombres están como literales en su código (`class.factronica.dte.php:635-636`). Como el SDK no se
 * modifica, la boleta se construye y se firma acá.
 *
 * ## Por qué se puede firmar sin una implementación completa de C14N
 *
 * La Canonicalización XML 1.0 hace varias cosas —normalizar fines de línea, expandir etiquetas
 * vacías, ordenar atributos, propagar namespaces, normalizar el escapado— pero sobre un documento
 * que **ya se genera en forma canónica** todas son la identidad salvo una: el fin de línea.
 *
 * Esto no es una suposición. Está verificado contra dos documentos reales:
 *
 * - La boleta 39 firmada por el propio motor de boletas de Factronica
 *   (`docs/dte-boleta/BOLETA_FOLIO777_TIPO39_DTEFIRMADO.xml`): su `<DigestValue>` es exactamente
 *   `sha1(<Documento> con CRLF→LF)`.
 * - Una factura firmada por el motor que corre en el box: mismo digest, y su `<SignatureValue>`
 *   verifica contra el `<SignedInfo>` reconstruido por `signedInfoCanonico()`.
 *
 * ## Los BYTES que se digieren son UTF-8, aunque el archivo viaje en ISO-8859-1
 *
 * C14N (REC-xml-c14n-20010315 §2.3) define la forma canónica como texto codificado en UTF-8,
 * sin importar la codificación del documento original. El SII digiere eso, y el SDK de Factronica
 * también: `sha1($dom->C14N())` (`class.factronica.dte.php:45`), y `DOMDocument::C14N()` devuelve
 * UTF-8. Los dos documentos de referencia de arriba son ASCII puro, donde Latin-1 y UTF-8 son los
 * mismos bytes: por eso una versión anterior que digería Latin-1 "verificaba" y aun así el SII
 * rechazó por firma (`RFR`) las dos primeras boletas de producción con una Ñ, una ú y una É
 * (folios 10008 y 10012 de 77840802-3, 2026-09-04 y 2026-09-10). El test de regresión pinea el
 * digest de un documento con acentos contra el que produce una implementación C14N real (lxml).
 *
 * El TED es otra historia: el `<DD>` se firma sobre sus bytes ISO-8859-1 (`firmarTed`), como hace
 * el SDK con el string crudo del TXT (`class.factronica.dte.php:20`). Son dos firmas con dos
 * reglas; no unificarlas.
 *
 * Las condiciones que hacen válido el atajo las garantiza el generador, no el azar, y por eso están
 * chequeadas en `assertCanonico()`: sin etiquetas auto-cerradas, sin comentarios, sin CDATA, sin
 * declaraciones de namespace internas y sin CRLF. Si alguna se rompe, el documento se rechaza antes
 * de firmarse en vez de producir una firma que el SII no valida.
 *
 * ## El detalle que confunde al leer el SDK
 *
 * El `<SignedInfo>` que se FIRMA no es byte a byte el que se EMBEBE: el firmado lleva el `xmlns`
 * heredado y las etiquetas en forma larga; el embebido va sin `xmlns` (lo hereda de `<Signature>`) y
 * con etiquetas auto-cerradas. Es correcto: canonicalizar el embebido produce exactamente el
 * firmado. El SDK hace lo mismo (`class.factronica.dte.php:244` vs `:253`).
 *
 * Dominio puro: no toca red, disco ni base de datos.
 */

const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
const ALG_C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

/** Escapa un valor de texto según C14N: `&`, `<` y `>`. Las comillas NO se tocan en texto. */
export function escaparTextoXml(valor: string): string {
  return normalizarLatin1(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escapa un valor de atributo según C14N: además de lo anterior, `"` y el retorno de carro. */
export function escaparAtributoXml(valor: string): string {
  return escaparTextoXml(valor).replace(/"/g, "&quot;").replace(/\r/g, "&#xD;");
}

/**
 * Comprueba que el XML cumpla las condiciones bajo las cuales C14N se reduce a normalizar el fin de
 * línea. Falla temprano y con motivo: una firma inválida se descubre recién cuando el SII rechaza.
 */
/**
 * Busca una declaración de namespace que repita la que ya está EN ALCANCE desde un ancestro.
 *
 * Es la única forma de redundancia que rompe el atajo: C14N la elimina, y el digest dejaría de
 * corresponder al texto. Ojo con la trampa de contarlas por string: dos elementos HERMANOS que
 * declaran el mismo namespace —dos `<Signature>` en un sobre con dos boletas— son perfectamente
 * válidos y C14N los deja intactos. Por eso hay que seguir el anidamiento y no sólo contar.
 *
 * Devuelve la declaración culpable, o `null` si no hay.
 */
function namespaceRedundante(xml: string): string | null {
  const pila: Array<Map<string, string>> = [new Map()];
  const enAlcance = (prefijo: string): string | undefined => {
    for (let i = pila.length - 1; i >= 0; i--) {
      const v = pila[i].get(prefijo);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w.-]*)((?:[^">]|"[^"]*")*)>/g)) {
    const [, cierre, , atributos] = m;
    if (cierre) {
      if (pila.length > 1) pila.pop();
      continue;
    }
    const propias = new Map<string, string>();
    for (const d of atributos.matchAll(/\sxmlns(?::([A-Za-z_][\w.-]*))?="([^"]*)"/g)) {
      const prefijo = d[1] ?? "";
      const uri = d[2];
      if (enAlcance(prefijo) === uri) return d[0].trim();
      propias.set(prefijo, uri);
    }
    pila.push(propias);
  }
  return null;
}

export function assertCanonico(xml: string): void {
  const problemas: string[] = [];
  if (/<[^!?][^>]*\/>/.test(xml)) {
    problemas.push("hay etiquetas auto-cerradas (C14N las expande a par de apertura y cierre)");
  }
  if (xml.includes("<!--")) problemas.push("hay comentarios (C14N los elimina)");
  if (xml.includes("<![CDATA[")) problemas.push("hay secciones CDATA (C14N las convierte a texto)");
  const redundante = namespaceRedundante(xml);
  if (redundante) {
    problemas.push(`hay una declaración de namespace redundante (C14N la elimina): ${redundante}`);
  }
  // El fin de línea NO se chequea: normalizarlo es lo único que C14N sí hace acá, y lo hace
  // `canonicalizar`. Prohibirlo rechazaría documentos ajenos perfectamente válidos — por ejemplo la
  // boleta de referencia del proveedor, que viene con CRLF.
  if (problemas.length > 0) {
    throw new Error(`El XML no está en forma canónica: ${problemas.join("; ")}.`);
  }
}

/**
 * Expande las etiquetas vacías (`<X/>` → `<X></X>`), que es una de las cosas que hace C14N.
 *
 * Hace falta para embeber en un sobre un documento que **no generamos nosotros**: los que produce el
 * motor de Factronica traen el `<Signature>` con etiquetas auto-cerradas, y digerir el `<SetDTE>`
 * como texto crudo daría un digest que no corresponde a su forma canónica.
 *
 * No cambia el significado del documento ni invalida su firma interna: esa firma cubre el
 * `<Documento>` (que no tiene etiquetas vacías) y se verifica canonicalizando, que expande igual.
 *
 * El reconocimiento de atributos respeta las comillas, así que un valor que contenga `/>` no parte
 * la etiqueta por la mitad.
 */
export function expandirEtiquetasVacias(xml: string): string {
  return xml.replace(
    /<([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/g,
    (_, nombre: string, atributos: string) => `<${nombre}${atributos}></${nombre}>`,
  );
}

/**
 * Deja un documento ajeno (por ejemplo, uno firmado por el motor) en la forma canónica que exige
 * embeberlo en un sobre nuestro.
 */
export function normalizarDocumentoAjeno(xml: string): string {
  return expandirEtiquetasVacias(xml.replace(/\r\n?/g, "\n"));
}

/**
 * Canonicaliza un fragmento ya generado en forma canónica y lo devuelve en los BYTES que se firman.
 *
 * Son bytes UTF-8 aunque el archivo se declare ISO-8859-1: la forma canónica es UTF-8 por
 * definición (C14N §2.3) y es sobre ella que el SII calcula el digest. Digerir los bytes Latin-1
 * del archivo produce el mismo resultado sólo mientras el documento es ASCII puro — con una Ñ ya
 * son otros bytes y la firma no valida (rechazo `RFR`, ver el encabezado de este archivo).
 */
export function canonicalizar(xml: string): Buffer {
  assertCanonico(xml);
  // El archivo se escribe en ISO-8859-1: un carácter fuera de Latin-1 no cabe (`Buffer "latin1"`
  // trunca al byte bajo), así que lo que se firmaría no es lo que se manda y el SII rechaza por
  // firma con el folio ya quemado. Los generadores normalizan con `normalizarLatin1`; esto es la
  // última red, y corta ANTES de firmar.
  const fuera = /[^\u0000-\u00ff]/u.exec(xml);
  if (fuera) {
    const cp = (fuera[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    throw new Error(
      `El XML trae un carácter fuera de ISO-8859-1 (U+${cp}) y no se puede firmar: el archivo se ` +
        `escribe en Latin-1 y no lo podría contener. Normalizar el texto con normalizarLatin1.`,
    );
  }
  // C14N normaliza a LF tanto el CRLF como el CR suelto.
  return Buffer.from(expandirReferenciasDeTexto(xml.replace(/\r\n?/g, "\n")), "utf8");
}

/**
 * En los nodos de TEXTO, C14N (§2.3) sólo conserva `&amp;`, `&lt;`, `&gt;` y `&#xD;`; toda otra
 * referencia se emite como el carácter que representa. El motor de Factronica escribe `&quot;` y
 * `&apos;` (`ConvertirCaracteres`) y nuestro TXT también (`escaparXml`), así que un `<Documento>`
 * con `LECHE &quot;SOPROLE&quot;` se digiere como `LECHE "SOPROLE"`: digerir el texto crudo daba
 * un `DigestValue` que el SII no reconoce (RFR). En los ATRIBUTOS `&quot;` sí se conserva, por eso
 * sólo se tocan los tramos entre `>` y `<`. El archivo no cambia: esto afecta lo que se firma, no
 * lo que se escribe (y por eso el `<DD>` del TED, firmado sobre sus bytes crudos, queda intacto).
 * Digest pineado contra lxml en `dte-firma.test.ts`.
 */
function expandirReferenciasDeTexto(xml: string): string {
  // Lo que C14N vuelve a escapar en texto aunque venga como referencia numérica.
  const CANONICO: Record<number, string> = { 38: "&amp;", 60: "&lt;", 62: "&gt;", 13: "&#xD;" };
  // Una referencia a un código que no es un carácter (fuera de Unicode o un surrogate) es XML mal
  // formado: se deja tal cual para que falle la validación de esquema, no el firmador.
  const caracter = (codigo: number, original: string): string =>
    codigo > 0x10ffff || (codigo >= 0xd800 && codigo <= 0xdfff)
      ? original
      : (CANONICO[codigo] ?? String.fromCodePoint(codigo));
  return xml.replace(/>([^<]*)</g, (_m, texto: string) =>
    ">" +
    texto
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (r, d: string) => caracter(Number(d), r))
      .replace(/&#x([0-9a-fA-F]+);/g, (r, h: string) => caracter(parseInt(h, 16), r)) +
    "<");
}

/** Digest SHA-1 en base64 de un fragmento canonicalizado — el `<DigestValue>` de la referencia. */
export function digestioSha1(xml: string): string {
  return createHash("sha1").update(canonicalizar(xml)).digest("base64");
}

/**
 * La referencia del `<Reference>`: `#id` para firmar un elemento con `ID`, o **vacía** para firmar
 * el documento entero.
 *
 * La vacía la usa el `<getToken>` con el que se pide el token al SII: ahí no hay ningún `ID` al que
 * apuntar, y la transformada `enveloped-signature` se encarga de excluir la propia firma.
 */
function referencia(uri: string): string {
  return uri === "" ? "" : `#${escaparAtributoXml(uri)}`;
}

/**
 * El `<SignedInfo>` tal como queda DESPUÉS de canonicalizar: con el `xmlns` que hereda de
 * `<Signature>` y las etiquetas vacías expandidas. Es el string que se firma.
 */
export function signedInfoCanonico(uri: string, digestion: string, nsHeredados = ""): string {
  return (
    `<SignedInfo xmlns="${NS_DSIG}"${nsHeredados}>` +
    `<CanonicalizationMethod Algorithm="${ALG_C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${NS_DSIG}rsa-sha1"></SignatureMethod>` +
    `<Reference URI="${referencia(uri)}">` +
    `<Transforms><Transform Algorithm="${NS_DSIG}enveloped-signature"></Transform></Transforms>` +
    `<DigestMethod Algorithm="${NS_DSIG}sha1"></DigestMethod>` +
    `<DigestValue>${digestion}</DigestValue>` +
    `</Reference></SignedInfo>`
  );
}

export interface CertificadoFirmante {
  /** Llave privada en PEM, ya descifrada. */
  llavePrivadaPem: string;
  /** Módulo RSA en base64, para el `<KeyInfo>`. */
  modulus: string;
  /** Exponente RSA en base64. */
  exponent: string;
  /** Certificado X.509 en base64 (sin cabeceras PEM). */
  x509: string;
}

/**
 * Firma un `<Documento>` y devuelve el bloque `<Signature>` listo para pegar dentro del `<DTE>`.
 *
 * `uri` es el `ID` del `<Documento>`; la referencia apunta a `#uri`. El digest se calcula sobre el
 * documento SIN firma, que es justo lo que exige la transformada `enveloped-signature`.
 */
export function firmarDocumento(
  documentoXml: string,
  uri: string,
  cert: CertificadoFirmante,
  /**
   * Declaraciones de namespace que el `<SignedInfo>` HEREDA de la raíz del documento y que C14N le
   * agrega al canonicalizarlo suelto. Para el `<DTE>` es vacío; para el sobre hay que pasar el
   * `xmlns:xsi` que declara `<EnvioBOLETA>` (el SDK hace lo mismo en
   * `class.factronica.dte.php:148`). Omitirlo produce una firma que no valida.
   */
  nsHeredados = "",
): string {
  const digestion = digestioSha1(documentoXml);
  const firmador = createSign("RSA-SHA1");
  // El <SignedInfo> también se firma en su forma canónica, que es UTF-8 (hoy es ASCII: mismos
  // bytes; se declara UTF-8 para que siga siendo correcto si algún día lleva un atributo acentuado).
  firmador.update(Buffer.from(signedInfoCanonico(uri, digestion, nsHeredados), "utf8"));
  const signatureValue = firmador.sign(cert.llavePrivadaPem).toString("base64");

  // Forma EMBEBIDA: sin xmlns propio en `<SignedInfo>` (lo hereda de `<Signature>`).
  //
  // Las etiquetas van EXPANDIDAS, no auto-cerradas. El SDK y el ejemplo del proveedor las embeben
  // auto-cerradas y les funciona porque digieren con un C14N de verdad, que las expande. Acá el
  // bloque tiene que quedar ya canónico: si no, al firmar el `<SetDTE>` del sobre —que lo contiene—
  // el digest se calcularía sobre un texto que no es su forma canónica. Las dos formas son
  // equivalentes para el SII; ésta además es la que sale de canonicalizar.
  //
  // Los `\n` entre hijos de `<Signature>` NO son cosméticos: el parser del SII rechaza cualquier
  // renglón de más de ~4.000 caracteres (`CHR-00002: Line too long (4090)`, verificado en producción
  // el 2026-08-28 con el trackid 23516044422). Son texto entre elementos, que C14N preserva, así que
  // el digest del `<SetDTE>` que contenga este bloque sigue siendo el de su forma canónica. No se
  // parte el `<SignedInfo>`: ese string es EXACTAMENTE lo que firma `signatureValue`.
  return (
    `<Signature xmlns="${NS_DSIG}"><SignedInfo>` +
    `<CanonicalizationMethod Algorithm="${ALG_C14N}"></CanonicalizationMethod>` +
    `<SignatureMethod Algorithm="${NS_DSIG}rsa-sha1"></SignatureMethod>` +
    `<Reference URI="${referencia(uri)}">` +
    `<Transforms><Transform Algorithm="${NS_DSIG}enveloped-signature"></Transform></Transforms>` +
    `<DigestMethod Algorithm="${NS_DSIG}sha1"></DigestMethod>` +
    `<DigestValue>${digestion}</DigestValue>` +
    `</Reference></SignedInfo>\n` +
    `<SignatureValue>${signatureValue}</SignatureValue>\n` +
    `<KeyInfo><KeyValue><RSAKeyValue>` +
    `<Modulus>${cert.modulus}</Modulus><Exponent>${cert.exponent}</Exponent>` +
    `</RSAKeyValue></KeyValue>\n` +
    `<X509Data><X509Certificate>${cert.x509}</X509Certificate></X509Data>` +
    `</KeyInfo></Signature>`
  );
}

/**
 * Firma el `<DD>` del timbre con la llave privada del CAF y devuelve el `<FRMT>` en base64.
 *
 * Contraparte exacta de `verificarFirmaTed` (`core/dte-ted.ts`): el SII firma y verifica el `<DD>`
 * COMPLETO —con sus etiquetas, byte a byte— sobre los bytes Latin-1. Acá NO aplica C14N ni UTF-8:
 * el TED no es una firma XML-DSig sino la firma de un string, y el SDK firma el string crudo del
 * TXT (ISO-8859-1) con `openssl_sign` (`class.factronica.dte.php:20`). Ese es el mismo contenido
 * que va en el PDF417 impreso.
 */
export function firmarTed(dd: string, llaveCafPem: string): string {
  const firmador = createSign("RSA-SHA1");
  firmador.update(Buffer.from(dd, "latin1"));
  return firmador.sign(llaveCafPem).toString("base64");
}
