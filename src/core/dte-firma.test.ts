import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizar, digestioSha1, escaparTextoXml } from "./dte-firma";

/**
 * Regresión de producción (2026-09-04 y 2026-09-10, folios 10008 y 10012 de 77840802-3): el SII
 * rechazó por firma (`RFR`) las dos primeras boletas con un carácter no ASCII (Ñ, ú, É). El digest
 * se calculaba sobre los bytes Latin-1 del archivo; la forma canónica (C14N §2.3) es UTF-8 y es lo
 * que digiere el SII. Las boletas ASCII pasaban porque ahí Latin-1 y UTF-8 son los mismos bytes.
 *
 * El valor esperado NO sale de esta implementación: lo produjo lxml (`etree.tostring(nodo,
 * method="c14n")` + SHA-1) sobre exactamente este fragmento. Si alguien vuelve a digerir Latin-1,
 * este test falla con el digest que el SII rechazaba (`wDexuzFltLTIWU/pmt0hNPR2B50=`).
 */
const FRAGMENTO_CON_ACENTOS =
  `<Documento ID="F1T39">\n` +
  `<Encabezado><IdDoc><TipoDTE>39</TipoDTE><Folio>1</Folio></IdDoc></Encabezado>\n` +
  `<Detalle><NroLinDet>1</NroLinDet><NmbItem>${escaparTextoXml("DORITOS TAMAÑO FAMILIAR & MÁS azúcar")}</NmbItem><MontoItem>1580</MontoItem></Detalle>\n` +
  `</Documento>`;

const DIGEST_C14N_REAL = "jNly1uAvmpAGQIoPay815kduv8k=";
const DIGEST_LATIN1_RECHAZADO = "wDexuzFltLTIWU/pmt0hNPR2B50=";

describe("digest de la firma XML: referencias de caracteres en texto", () => {
  // Oráculo: lxml `etree.tostring(el, method="c14n")` + sha1 (2026-09-30). El motor de Factronica
  // escribe `&quot;`/`&apos;` en NmbItem/RznSoc; C14N los expande en texto y los conserva en
  // atributos. Digerir el texto crudo daba `3F8ZbuW89tfovLZW7eG+rHPEzbY=` → RFR del SII.
  const SET_DTE =
    `<SetDTE xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ID="SetDte">\n` +
    `<Caratula version="1.0"><RutEmisor>77840802-3</RutEmisor></Caratula>\n` +
    `<DTE version="1.0">\n<Documento ID="F1T61">\n` +
    `<NmbItem>LECHE &quot;SOPROLE&quot; O&apos;HIGGINS &amp; CIA &lt;3</NmbItem>\n` +
    `<Nota attr="a &quot;b&quot;">x</Nota>\n</Documento>\n</DTE>\n</SetDTE>`;

  it("expande &quot;/&apos; en texto y los conserva en atributos, como lxml", () => {
    expect(digestioSha1(SET_DTE)).toBe("MRME7OtAZZ8CETel7E3SPT/gpyE=");
    const canonico = canonicalizar(SET_DTE).toString("utf8");
    expect(canonico).toContain(`<NmbItem>LECHE "SOPROLE" O'HIGGINS &amp; CIA &lt;3</NmbItem>`);
    expect(canonico).toContain(`<Nota attr="a &quot;b&quot;">x</Nota>`);
  });

  it("las referencias numéricas se expanden; &, <, > y CR vuelven a su forma canónica (oráculo lxml)", () => {
    // lxml: c14n(b'<A>&#38;&#60;&#62;&#13;&#39;</A>') == b"<A>&amp;&lt;&gt;&#xD;'</A>"
    expect(canonicalizar(`<A>&#38;&#60;&#62;&#13;&#39;</A>`).toString("utf8")).toBe(`<A>&amp;&lt;&gt;&#xD;'</A>`);
    expect(canonicalizar(`<A>&#x22;&#xD;&#193;</A>`).toString("utf8")).toBe(`<A>"&#xD;Á</A>`);
  });
});

describe("digest de la firma XML: forma canónica en UTF-8", () => {
  it("con acentos, el digest es el de C14N real (lxml), no el de los bytes Latin-1", () => {
    expect(digestioSha1(FRAGMENTO_CON_ACENTOS)).toBe(DIGEST_C14N_REAL);
    expect(digestioSha1(FRAGMENTO_CON_ACENTOS)).not.toBe(DIGEST_LATIN1_RECHAZADO);
    // Y el rechazado es exactamente lo que da Latin-1: documenta el bug, no un número al azar.
    const latin1 = createHash("sha1").update(Buffer.from(FRAGMENTO_CON_ACENTOS, "latin1")).digest("base64");
    expect(latin1).toBe(DIGEST_LATIN1_RECHAZADO);
  });

  it("los bytes canónicos son UTF-8: la Ñ ocupa dos bytes", () => {
    const bytes = canonicalizar("<X>Ñ</X>");
    expect([...bytes]).toEqual([...Buffer.from("<X>Ñ</X>", "utf8")]);
    expect(bytes.length).toBe(9);
  });

  it("en ASCII puro los dos criterios coinciden (por eso el bug no se veía)", () => {
    const ascii = FRAGMENTO_CON_ACENTOS.replace("TAMAÑO", "TAMANO").replace("MÁS", "MAS").replace("azúcar", "azucar");
    const latin1 = createHash("sha1").update(Buffer.from(ascii, "latin1")).digest("base64");
    expect(digestioSha1(ascii)).toBe(latin1);
  });

  it("normaliza CRLF a LF antes de digerir (lo único que C14N cambia en un documento canónico)", () => {
    expect(digestioSha1(FRAGMENTO_CON_ACENTOS.replace(/\n/g, "\r\n"))).toBe(DIGEST_C14N_REAL);
  });
});

describe("canonicalizar: lo que se firma tiene que caber en el archivo Latin-1", () => {
  it("un CR suelto también se normaliza a LF", () => {
    expect(digestioSha1(FRAGMENTO_CON_ACENTOS.replace(/\n/g, "\r"))).toBe(DIGEST_C14N_REAL);
  });

  it("rechaza un carácter fuera de ISO-8859-1 antes de firmar (el archivo no lo podría contener)", () => {
    // Comilla tipográfica de Excel (U+201C): Buffer latin1 la truncaría al byte 0x1C.
    expect(() => canonicalizar("<X>CERVEZA \u201CCRISTAL\u201D</X>")).toThrow(/U\+201C/);
    // Emoji (fuera del BMP): el mensaje trae el code point completo, no el surrogate.
    expect(() => canonicalizar("<X>PAN \u{1F35E}</X>")).toThrow(/U\+1F35E/);
    // Latin-1 completo pasa: acentos, ñ, signos de apertura.
    expect(() => canonicalizar("<X>¿PIÑA EN ALMÍBAR? ¡Sí!</X>")).not.toThrow();
  });
});
