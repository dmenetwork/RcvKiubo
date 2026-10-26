import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digestioSha1, escaparTextoXml, firmarDocumento, signedInfoCanonico } from "./dte-firma";
import { parsearEnvioDte } from "./dte-recepcion";
import { serializarSobre } from "./__fixtures__/dte-sobre";
import {
  verificarCaf,
  verificarDteRecibido,
  verificarFirmaDocumento,
  verificarFirmaXml,
  verificarTimbre,
} from "./dte-verificacion";
import {
  RUT_KIUBO,
  RUT_PROVEEDOR,
  cafDePrueba,
  certificadoDePrueba,
  dteDePrueba,
  llaveSiiDePrueba,
} from "./__fixtures__/material";

const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
const CERT = certificadoDePrueba();
const SII = llaveSiiDePrueba();
const CAF = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: SII.privada });
const LLAVES = { "100": SII.publica };

const unico = (xml: string) => parsearEnvioDte(xml).dtes[0];

/** Una firma con el DigestValue que se le pida: para simular firmadores que digieren mal. */
function firmaConDigest(uri: string, digest: string): string {
  const si = signedInfoCanonico(uri, digest);
  const firmador = createSign("RSA-SHA1");
  firmador.update(Buffer.from(si, "utf8"));
  return (
    `<Signature xmlns="${NS_DSIG}">${si.replace(` xmlns="${NS_DSIG}"`, "")}` +
    `<SignatureValue>${firmador.sign(CERT.llavePrivadaPem).toString("base64")}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${CERT.x509}</X509Certificate></X509Data></KeyInfo></Signature>`
  );
}

describe("verificarDteRecibido: un DTE firmado por el firmador de Kiubo", () => {
  it("verifica completo: firma del documento, FRMT, DD contra encabezado, FRMA del CAF y totales", () => {
    const d = unico(dteDePrueba({ folio: 11 }, CAF, CERT));
    expect(verificarDteRecibido(d, { ambiente: "certificacion", llavesSii: LLAVES })).toEqual({
      ok: true, problemas: [], sinLlaveSii: false,
    });
  });

  it("un sobre con 3 DTE da 3 resultados, cada uno con su verificación", () => {
    const sobre = serializarSobre(
      [21, 22, 23].map((folio) => ({ tipoDte: 33, xml: dteDePrueba({ folio, neto: folio * 1000 }, CAF, CERT) })),
      { rutEmisor: RUT_PROVEEDOR, rutEnvia: "11598736-4", rutReceptor: RUT_KIUBO, fechaResolucion: "2014-08-22", numeroResolucion: "80" },
      CERT,
      new Date("2026-10-01T13:00:00Z"),
      "dte",
    );
    const resultados = parsearEnvioDte(sobre).dtes.map((d) => verificarDteRecibido(d, { ambiente: "certificacion", llavesSii: LLAVES }));
    expect(resultados).toHaveLength(3);
    expect(resultados.every((r) => r.ok)).toBe(true);
  });

  it("un monto adulterado rompe la firma del documento", () => {
    const xml = dteDePrueba({ folio: 12 }, CAF, CERT).replace("<MntNeto>10000</MntNeto>", "<MntNeto>1000</MntNeto>")
      .replace("<IVA>1900</IVA>", "<IVA>10900</IVA>");
    expect(verificarFirmaDocumento(xml)).toMatchObject({ estado: "falla", motivo: expect.stringMatching(/DigestValue/) });
    const r = verificarDteRecibido(unico(xml), { ambiente: "certificacion", llavesSii: LLAVES });
    expect(r.ok).toBe(false);
    expect(r.problemas).toEqual([expect.stringMatching(/^firma del documento/)]);
  });

  it("sin la llave del SII no pasa ni falla: queda sinLlaveSii", () => {
    const r = verificarDteRecibido(unico(dteDePrueba({ folio: 13 }, CAF, CERT)), { ambiente: "certificacion" });
    expect(r).toEqual({ ok: false, problemas: [], sinLlaveSii: true });
  });

  it("un CAF de certificación (IDK 100) no vale para un receptor en producción", () => {
    const r = verificarDteRecibido(unico(dteDePrueba({ folio: 14 }, CAF, CERT)), { ambiente: "produccion", llavesSii: LLAVES });
    expect(r.ok).toBe(false);
    expect(r.problemas.join(" ")).toMatch(/IDK 100/);
  });

  it("totales que no cuadran son problema aunque todo lo firmado sea coherente", () => {
    const r = verificarDteRecibido(unico(dteDePrueba({ folio: 15, total: 99_999 }, CAF, CERT)), { ambiente: "certificacion", llavesSii: LLAVES });
    expect(r.problemas).toEqual([expect.stringMatching(/no cuadra/)]);
  });
});

describe("firma del documento: lo que digiere el SII (UTF-8 y referencias expandidas)", () => {
  // El mismo fragmento y el mismo digest que pinea `dte-firma.test.ts` contra lxml (C14N real): el
  // valor esperado no sale de este código.
  const FRAGMENTO =
    `<Documento ID="F1T39">\n` +
    `<Encabezado><IdDoc><TipoDTE>39</TipoDTE><Folio>1</Folio></IdDoc></Encabezado>\n` +
    `<Detalle><NroLinDet>1</NroLinDet><NmbItem>${escaparTextoXml("DORITOS TAMAÑO FAMILIAR & MÁS azúcar")}</NmbItem><MontoItem>1580</MontoItem></Detalle>\n` +
    `</Documento>`;
  const DIGEST_LXML = "jNly1uAvmpAGQIoPay815kduv8k=";

  it("con Ñ y acentos verifica con el digest de C14N real", () => {
    const firma = firmarDocumento(FRAGMENTO, "F1T39", CERT);
    expect(firma).toContain(`<DigestValue>${DIGEST_LXML}</DigestValue>`);
    expect(verificarFirmaDocumento(`<DTE version="1.0">${FRAGMENTO}${firma}</DTE>`)).toEqual({ estado: "ok" });
  });

  it("una firma digerida sobre los bytes Latin-1 (el bug de los RFR) NO verifica", () => {
    const latin1 = createHash("sha1").update(Buffer.from(FRAGMENTO, "latin1")).digest("base64");
    expect(verificarFirmaXml(FRAGMENTO, firmaConDigest("F1T39", latin1))).toMatchObject({ estado: "falla" });
    expect(verificarFirmaXml(FRAGMENTO, firmaConDigest("F1T39", DIGEST_LXML))).toEqual({ estado: "ok" });
  });

  it("&quot; en el texto se expande antes de digerir (oráculo lxml del SetDTE de dte-firma.test)", () => {
    const SET_DTE =
      `<SetDTE xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ID="SetDte">\n` +
      `<Caratula version="1.0"><RutEmisor>77840802-3</RutEmisor></Caratula>\n` +
      `<DTE version="1.0">\n<Documento ID="F1T61">\n` +
      `<NmbItem>LECHE &quot;SOPROLE&quot; O&apos;HIGGINS &amp; CIA &lt;3</NmbItem>\n` +
      `<Nota attr="a &quot;b&quot;">x</Nota>\n</Documento>\n</DTE>\n</SetDTE>`;
    expect(verificarFirmaXml(SET_DTE, firmaConDigest("SetDte", "MRME7OtAZZ8CETel7E3SPT/gpyE="))).toEqual({ estado: "ok" });
    // Digerir el texto crudo (sin expandir &quot;) es lo que el SII rechazaba.
    const crudo = createHash("sha1").update(Buffer.from(SET_DTE, "utf8")).digest("base64");
    expect(verificarFirmaXml(SET_DTE, firmaConDigest("SetDte", crudo))).toMatchObject({ estado: "falla" });
  });

  it("razón social con Ñ y &quot; firmada por Kiubo y viajando en Latin-1 verifica", () => {
    const bytes = Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?>\n${dteDePrueba({ folio: 16 }, CAF, CERT)}`, "latin1");
    expect(bytes.includes(Buffer.from([0xd1]))).toBe(true); // la Ñ es UN byte en el archivo
    const d = parsearEnvioDte(bytes).dtes[0];
    expect(d.rznSoc).toBe('COMERCIAL ÑANDÚ "LA ESTRELLA" LTDA');
    expect(verificarFirmaDocumento(d.xml)).toEqual({ estado: "ok" });
  });
});

describe("firma del documento: firmadores de terceros", () => {
  it("verifica un DTE firmado por el motor Factronica (PHP, DOMDocument::C14N + openssl_sign)", () => {
    const xml = readFileSync(join(__dirname, "__fixtures__", "EJEMPLO-motor-facturas-emitiendo-39.xml"));
    const d = parsearEnvioDte(xml).dtes[0];
    expect(verificarFirmaDocumento(d.xml)).toEqual({ estado: "ok" });
    expect(verificarTimbre(d)).toEqual({ estado: "ok" });
    expect(verificarFirmaDocumento(d.xml.replace("<Folio>902</Folio>", "<Folio>903</Folio>")).estado).toBe("falla");
  });

  it("acepta los contextos de namespace en que firman otros emisores (xmlns del <DTE>, o el sobre entero)", () => {
    const xml = dteDePrueba({ folio: 17 }, CAF, CERT);
    const documento = /<Documento\b[\s\S]*?<\/Documento>/.exec(xml)![0];
    for (const ns of [
      ` xmlns="http://www.sii.cl/SiiDte"`,
      ` xmlns="http://www.sii.cl/SiiDte" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`,
    ]) {
      const firma = firmarDocumento(documento.replace("<Documento", `<Documento${ns}`), "F17T33", CERT);
      expect(verificarFirmaDocumento(`<DTE version="1.0">${documento}${firma}</DTE>`)).toEqual({ estado: "ok" });
    }
  });

  it("rechaza algoritmos que el SII no admite y una referencia a otro ID", () => {
    const xml = dteDePrueba({ folio: 18 }, CAF, CERT);
    expect(verificarFirmaDocumento(xml.replace("xmldsig#rsa-sha1", "xmldsig-more#rsa-sha256")))
      .toMatchObject({ estado: "falla", motivo: expect.stringMatching(/algoritmos/) });
    expect(verificarFirmaDocumento(xml.replace('URI="#F18T33"', 'URI="#OTRO"')))
      .toMatchObject({ estado: "falla", motivo: expect.stringMatching(/referencia/) });
  });

  /** El DTE de prueba re-firmado declarando la transformada `alg` en el <SignedInfo>. */
  function conTransformada(folio: number, alg: string, documento = (x: string) => x): string {
    const xml = dteDePrueba({ folio }, CAF, CERT);
    const doc = documento(/<Documento\b[\s\S]*<\/Documento>/.exec(xml)![0]);
    // El digest de C14N sin comentarios, como lo calcula el firmador del emisor.
    const digest = digestioSha1(doc.replace(/<!--[\s\S]*?-->/g, ""));
    const si = signedInfoCanonico(`F${folio}T33`, digest).replace(`${NS_DSIG}enveloped-signature`, alg);
    const firmador = createSign("RSA-SHA1");
    firmador.update(Buffer.from(si, "utf8"));
    const firma =
      `<Signature xmlns="${NS_DSIG}">${si.replace(` xmlns="${NS_DSIG}"`, "")}` +
      `<SignatureValue>${firmador.sign(CERT.llavePrivadaPem).toString("base64")}</SignatureValue>` +
      `<KeyInfo><X509Data><X509Certificate>${CERT.x509}</X509Certificate></X509Data></KeyInfo></Signature>`;
    return xml.replace(/<Documento\b[\s\S]*<\/Documento>/, doc).replace(/<Signature xmlns="[^"]+">[\s\S]*<\/Signature>/, firma);
  }
  const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

  it("acepta la transformada C14N que usan emisores reales (4 de 6 facturas del buzón de Belén, todas DOK en el SII)", () => {
    const xml = conTransformada(19, C14N);
    expect(xml).toContain(`${C14N}"></Transform>`);
    expect(verificarFirmaDocumento(xml)).toEqual({ estado: "ok" });
  });

  it("acepta C14N #WithComments (una NC real del buzón) sólo si el documento no tiene comentarios", () => {
    expect(verificarFirmaDocumento(conTransformada(20, `${C14N}#WithComments`))).toEqual({ estado: "ok" });
    const conComentario = conTransformada(21, `${C14N}#WithComments`, (d) => d.replace("<Encabezado>", "<Encabezado><!-- nota -->"));
    expect(verificarFirmaDocumento(conComentario)).toMatchObject({ estado: "falla", motivo: expect.stringMatching(/algoritmos/) });
  });

  it("una transformada que el SII no admite (C14N exclusivo) sigue siendo falla", () => {
    expect(verificarFirmaDocumento(conTransformada(22, "http://www.w3.org/2001/10/xml-exc-c14n#"))).toMatchObject({
      estado: "falla",
      motivo: expect.stringMatching(/algoritmos/),
    });
  });
});

describe("verificarCaf: la FRMA del SII sobre el <DA> aplanado", () => {
  it("verifica el CAF como viene en el archivo del SII (con saltos) y embebido en el TED (aplanado)", () => {
    const archivo = `<AUTORIZACION><CAF version="1.0">\n${CAF.daConSaltos}\n<FRMA algoritmo="SHA1withRSA">${CAF.frma}</FRMA>\n</CAF></AUTORIZACION>`;
    expect(verificarCaf(archivo, SII.publica)).toEqual({ estado: "ok" });
    expect(verificarCaf(CAF.bloque, SII.publica)).toEqual({ estado: "ok" });
  });

  it("falla con otra llave o con el rango adulterado", () => {
    const otra = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(verificarCaf(CAF.bloque, otra).estado).toBe("falla");
    expect(verificarCaf(CAF.bloque.replace("<H>100</H>", "<H>999</H>"), SII.publica).estado).toBe("falla");
  });

  it("sin llave devuelve sin_llave, que no es ni pase ni falla", () => {
    expect(verificarCaf(CAF.bloque, null)).toMatchObject({ estado: "sin_llave", motivo: expect.stringMatching(/IDK 100/) });
  });
});

describe("verificarTimbre: el <DD> tiene que ser de ESTE documento", () => {
  it("un TED válido pegado en otro documento (re-firmado) se detecta", () => {
    const real = dteDePrueba({ folio: 31, neto: 1000 }, CAF, CERT);
    const otro = dteDePrueba({ folio: 32, neto: 900_000 }, CAF, CERT);
    const ted = /<TED\b[\s\S]*?<\/TED>/.exec(real)![0];
    const documento = /<Documento\b[\s\S]*?<\/Documento>/.exec(otro)![0].replace(/<TED\b[\s\S]*?<\/TED>/, () => ted);
    const falso = `<DTE version="1.0">${documento}${firmarDocumento(documento, "F32T33", CERT)}</DTE>`;
    const d = unico(falso);
    // La firma del documento y el FRMT verifican por separado: por eso hace falta comparar el DD.
    expect(verificarFirmaDocumento(falso)).toEqual({ estado: "ok" });
    expect(verificarTimbre(d)).toMatchObject({ estado: "falla", motivo: expect.stringMatching(/folio.*monto total/) });
  });

  it("verifica un <DD> que el emisor guardó indentado (firmado aplanado, como LibreDTE)", () => {
    const xml = dteDePrueba({ folio: 33 }, CAF, CERT);
    const indentado = xml.replace(/<DD>[\s\S]*?<\/DD>/, (dd) => dd.replace(/></g, ">\n  <"));
    expect(verificarTimbre(unico(indentado))).toEqual({ estado: "ok" });
  });
});

// La llave que verifica la FRMT, el <DD> que se compara y el CAF cuya FRMA se prueba contra el SII
// tienen que ser del MISMO timbre. Con "el primero que aparezca", un CAF real (cualquier factura de un
// proveedor trae uno) pegado en otro lado validaba un timbre hecho con una llave propia.
describe("el timbre se verifica con SU CAF, no con el primero que aparezca", () => {
  it("un CAF real pegado fuera del timbre no hace pasar la FRMA de un CAF falsificado", () => {
    const OTRO_SII = llaveSiiDePrueba();
    const falso = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: OTRO_SII.privada });
    const xml = dteDePrueba({ folio: 21 }, falso, CERT).replace("<Documento", `${CAF.bloque}<Documento`);
    const r = verificarDteRecibido(unico(xml), { ambiente: "certificacion", llavesSii: LLAVES });
    expect(r.ok).toBe(false);
    expect(r.problemas.join(" ")).toMatch(/CAF/);
  });

  it("una llave de adorno dentro del <DD>, antes del CAF, no se usa para verificar la FRMT", () => {
    const xml = dteDePrueba({ folio: 22 }, CAF, CERT);
    const dd = /<DD>[\s\S]*?<\/DD>/.exec(xml)![0];
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 512 });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
    const b64 = (x: string) => Buffer.from(x, "base64url").toString("base64");
    const ddFalso = dd.replace("<DD>", `<DD><M>${b64(jwk.n)}</M><E>${b64(jwk.e)}</E>`);
    const frmt = createSign("RSA-SHA1").update(Buffer.from(ddFalso, "latin1")).sign(privateKey).toString("base64");
    const atacado = xml.replace(dd, ddFalso).replace(/<FRMT([^>]*)>[^<]*<\/FRMT>/, `<FRMT$1>${frmt}</FRMT>`);
    expect(verificarTimbre(unico(atacado)).estado).toBe("falla");
  });

  it("un documento con dos <TED> no verifica", () => {
    const xml = dteDePrueba({ folio: 23 }, CAF, CERT);
    const ted = /<TED\b[\s\S]*?<\/TED>/.exec(xml)![0];
    expect(verificarTimbre(unico(xml.replace(ted, ted + ted))).estado).toBe("falla");
  });
});

describe("la llave del timbre es la del <DA> que firma el SII", () => {
  it("un <RSAPK> de adorno dentro del CAF, antes del <DA> real, no verifica la FRMT", () => {
    const xml = dteDePrueba({ folio: 24 }, CAF, CERT);
    const dd = /<DD>[\s\S]*?<\/DD>/.exec(xml)![0];
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 512 });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
    const b64 = (x: string) => Buffer.from(x, "base64url").toString("base64");
    const ddFalso = dd.replace('<CAF version="1.0">', `<CAF version="1.0"><RSAPK><M>${b64(jwk.n)}</M><E>${b64(jwk.e)}</E></RSAPK>`);
    const frmt = createSign("RSA-SHA1").update(Buffer.from(ddFalso, "latin1")).sign(privateKey).toString("base64");
    const atacado = xml.replace(dd, ddFalso).replace(/<FRMT([^>]*)>[^<]*<\/FRMT>/, `<FRMT$1>${frmt}</FRMT>`);
    expect(verificarTimbre(unico(atacado)).estado).toBe("falla");
    expect(verificarDteRecibido(unico(atacado), { ambiente: "certificacion", llavesSii: LLAVES }).ok).toBe(false);
  });

  it("una llave de más de 2048 bits (CPU gratis para un desconocido) no se usa", () => {
    const xml = dteDePrueba({ folio: 25 }, CAF, CERT);
    const enorme = Buffer.alloc(300, 0xff).toString("base64");
    const atacado = xml.replace(/<M>[^<]*<\/M>/, `<M>${enorme}</M>`);
    const r = verificarTimbre(unico(atacado));
    expect(r.estado).toBe("falla");
    if (r.estado === "falla") expect(r.motivo).toMatch(/tamaño/);
  });
});
