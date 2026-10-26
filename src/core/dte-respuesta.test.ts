import { createPublicKey, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { digestioSha1, signedInfoCanonico } from "./dte-firma";
import { parsearEnvioDte } from "./dte-recepcion";
import {
  DECLARACION_LEY_19983,
  construirEnvioRecibos,
  construirRespuestaDte,
  serializarEnvioRecibos,
  type DocumentoDeRecibo,
} from "./dte-respuesta";
import { serializarSobre } from "./__fixtures__/dte-sobre";
import { verificarFirmaXml } from "./dte-verificacion";
import {
  RUT_KIUBO,
  RUT_PROVEEDOR,
  cafDePrueba,
  certificadoDePrueba,
  dteDePrueba,
  llaveSiiDePrueba,
} from "./__fixtures__/material";

/**
 * No hay XSD local de `RespuestaEnvioDTE_v10.xsd` ni de `EnvioRecibos_v10.xsd`: el orden que se
 * pinea aquí es el que documenta `dte-respuesta.ts` (tomado del pack `schema_ic.zip` del SII cuando
 * se escribió en api-facturacion). Las firmas, en cambio, se verifican de verdad.
 */

const NS_SII = "http://www.sii.cl/SiiDte";
const NS_XSI = "http://www.w3.org/2001/XMLSchema-instance";
const CERT = certificadoDePrueba();
const SII = llaveSiiDePrueba();
const CAF = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: SII.privada });
const AHORA = new Date("2026-10-02T15:30:00Z");

const ENVIO = parsearEnvioDte(
  serializarSobre(
    [{ tipoDte: 33, xml: dteDePrueba({ folio: 41 }, CAF, CERT) }],
    { rutEmisor: RUT_PROVEEDOR, rutEnvia: "11598736-4", rutReceptor: RUT_KIUBO, fechaResolucion: "2014-08-22", numeroResolucion: "80" },
    CERT,
    new Date("2026-10-01T13:00:00Z"),
    "dte",
  ),
);

/** Nombres de los hijos directos de un bloque, en orden. */
function hijos(xml: string, tag: string): string[] {
  const interior = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? "";
  const nombres: string[] = [];
  let profundidad = 0;
  for (const [, cierre, nombre] of interior.matchAll(/<(\/?)([A-Za-z]+)[^>]*>/g)) {
    if (cierre) profundidad--;
    else if (profundidad++ === 0) nombres.push(nombre);
  }
  return nombres;
}

/** ¿La SignatureValue de `firma` firma su SignedInfo en el contexto `nsHeredados`? */
function firmaEnContexto(firma: string, uri: string, nsHeredados: string): boolean {
  const digest = /<DigestValue>([^<]+)<\/DigestValue>/.exec(firma)![1];
  const valor = /<SignatureValue>([\s\S]*?)<\/SignatureValue>/.exec(firma)![1];
  const v = createVerify("RSA-SHA1");
  v.update(Buffer.from(signedInfoCanonico(uri, digest, nsHeredados), "utf8"));
  return v.verify(createPublicKey(CERT.llavePrivadaPem), Buffer.from(valor.replace(/\s+/g, ""), "base64"));
}

describe("RespuestaDTE: acuse de recibo del ENVÍO", () => {
  const xml = construirRespuestaDte(
    { rutResponde: RUT_KIUBO, rutRecibe: RUT_PROVEEDOR, idRespuesta: 1, mailContacto: "dte@kiubo.io" },
    {
      tipo: "recepcion",
      envios: [{
        nombreEnvio: "ENVIO_33_41.xml",
        fechaRecepcion: AHORA,
        codigoEnvio: 7,
        envioDteId: ENVIO.setDteId!,
        digest: ENVIO.digestSobre,
        rutEmisorEnvio: RUT_PROVEEDOR,
        rutReceptorEnvio: RUT_KIUBO,
        estado: 0,
        glosa: "Envío recibido conforme en la casilla de Ñuñoa",
      }],
    },
    CERT,
    AHORA,
  );
  const resultado = /<Resultado\b[\s\S]*?<\/Resultado>/.exec(xml)![0];
  const firma = /<Signature\b[\s\S]*?<\/Signature>/.exec(xml)![0];

  it("arma la carátula y el detalle en el orden del esquema, con el EnvioDTEID y el digest del sobre recibido", () => {
    expect(xml).toMatch(/^<RespuestaDTE xmlns="http:\/\/www\.sii\.cl\/SiiDte"[^>]*RespuestaEnvioDTE_v10\.xsd">/);
    expect(hijos(xml, "Caratula")).toEqual(["RutResponde", "RutRecibe", "IdRespuesta", "NroDetalles", "MailContacto", "TmstFirmaResp"]);
    expect(hijos(xml, "RecepcionEnvio")).toEqual([
      "NmbEnvio", "FchRecep", "CodEnvio", "EnvioDTEID", "Digest", "RutEmisor", "RutReceptor", "EstadoRecepEnv", "RecepEnvGlosa",
    ]);
    expect(xml).toContain("<NroDetalles>1</NroDetalles>");
    expect(xml).toContain(`<EnvioDTEID>SetDte</EnvioDTEID><Digest>${ENVIO.digestSobre}</Digest>`);
    expect(xml).toContain("<TmstFirmaResp>2026-10-02T12:30:00</TmstFirmaResp>");
  });

  it("la firma del <Resultado> verifica, con la Ñ de la glosa digerida en UTF-8", () => {
    expect(verificarFirmaXml(resultado, firma)).toEqual({ estado: "ok" });
    expect(firma).toContain(`<DigestValue>${digestioSha1(resultado)}</DigestValue>`);
    // El SignedInfo hereda el xmlns:xsi del <RespuestaDTE>: sin él no verifica en contexto.
    expect(firmaEnContexto(firma, "Resultado", ` xmlns:xsi="${NS_XSI}"`)).toBe(true);
    expect(firmaEnContexto(firma, "Resultado", "")).toBe(false);
  });

  it("rechaza un IdRespuesta 0 (el XSD es positiveInteger) y un detalle vacío", () => {
    const car = { rutResponde: RUT_KIUBO, rutRecibe: RUT_PROVEEDOR, idRespuesta: 0 };
    expect(() => construirRespuestaDte(car, { tipo: "resultado", documentos: [] }, CERT, AHORA)).toThrow(/sin detalle/);
    expect(() => construirRespuestaDte(car, {
      tipo: "resultado",
      documentos: [{ tipoDte: 33, folio: 41, fechaEmision: "2026-10-01", rutEmisor: RUT_PROVEEDOR, rutReceptor: RUT_KIUBO, montoTotal: 11_900, codigoEnvio: 7, estado: 2, glosa: "x" }],
    }, CERT, AHORA)).toThrow(/IdRespuesta/);
  });
});

describe("RespuestaDTE: resultado del documento (reclamo)", () => {
  it("lleva los datos del DTE recibido y EstadoDTE 2", () => {
    const d = ENVIO.dtes[0];
    const xml = construirRespuestaDte(
      { rutResponde: RUT_KIUBO, rutRecibe: RUT_PROVEEDOR, idRespuesta: 2 },
      {
        tipo: "resultado",
        documentos: [{
          tipoDte: d.tipoDte!, folio: d.folio!, fechaEmision: d.fchEmis!, rutEmisor: d.rutEmisor, rutReceptor: d.rutRecep,
          montoTotal: d.mntTotal!, codigoEnvio: 7, estado: 2, glosa: "Mercadería no recibida",
        }],
      },
      CERT,
      AHORA,
    );
    expect(hijos(xml, "ResultadoDTE")).toEqual([
      "TipoDTE", "Folio", "FchEmis", "RUTEmisor", "RUTRecep", "MntTotal", "CodEnvio", "EstadoDTE", "EstadoDTEGlosa",
    ]);
    expect(xml).toContain("<Folio>41</Folio>");
    expect(xml).toContain("<EstadoDTE>2</EstadoDTE>");
    expect(xml).not.toContain("<RecepcionEnvio>");
  });
});

describe("EnvioRecibos (Ley 19.983): dos niveles de firma", () => {
  const recibo = (folio: number): DocumentoDeRecibo => ({
    tipoDoc: 33, folio, fechaEmision: "2026-10-01", rutEmisor: RUT_PROVEEDOR, rutReceptor: RUT_KIUBO,
    montoTotal: 11_900, recinto: "BODEGA ÑUÑOA", rutFirma: "11598736-4",
  });
  const xml = construirEnvioRecibos(
    { rutResponde: RUT_KIUBO, rutRecibe: RUT_PROVEEDOR, nombreContacto: "Recepción" },
    [recibo(41), recibo(42)],
    CERT,
    AHORA,
  );

  it("una firma por Recibo y otra sobre el SetRecibos", () => {
    expect(xml.match(/<Signature\b/g)).toHaveLength(3);
    expect(hijos(xml, "DocumentoRecibo")).toEqual([
      "TipoDoc", "Folio", "FchEmis", "RUTEmisor", "RUTRecep", "MntTotal", "Recinto", "RutFirma", "Declaracion", "TmstFirmaRecibo",
    ]);
    expect(xml).toContain(`<Declaracion>${DECLARACION_LEY_19983}</Declaracion>`);
  });

  it("cada Recibo se firma en su contexto: el DocumentoRecibo con el xmlns heredado del SetRecibos", () => {
    const recibos = [...xml.matchAll(/<Recibo version="1\.0">([\s\S]*?)<\/Recibo>/g)].map((m) => m[1]);
    expect(recibos).toHaveLength(2);
    recibos.forEach((r, i) => {
      const doc = /<DocumentoRecibo\b[\s\S]*?<\/DocumentoRecibo>/.exec(r)![0];
      const firma = /<Signature\b[\s\S]*?<\/Signature>/.exec(r)![0];
      const enContexto = doc.replace("<DocumentoRecibo ", `<DocumentoRecibo xmlns="${NS_SII}" xmlns:xsi="${NS_XSI}" `);
      expect(firma).toContain(`<DigestValue>${digestioSha1(enContexto)}</DigestValue>`);
      expect(firmaEnContexto(firma, `R${i + 1}`, ` xmlns:xsi="${NS_XSI}"`)).toBe(true);
      expect(verificarFirmaXml(doc, firma)).toEqual({ estado: "ok" });
    });
  });

  it("la firma del SetRecibos cubre los recibos con sus firmas", () => {
    const set = /<SetRecibos\b[\s\S]*?<\/SetRecibos>/.exec(xml)![0];
    const externa = xml.slice(xml.indexOf("</SetRecibos>"));
    const firma = /<Signature\b[\s\S]*?<\/Signature>/.exec(externa)![0];
    expect(verificarFirmaXml(set, firma)).toEqual({ estado: "ok" });
    expect(verificarFirmaXml(set.replace("<Folio>42</Folio>", "<Folio>43</Folio>"), firma).estado).toBe("falla");
  });

  it("rechaza un tipo que el esquema no admite (43) y un recinto vacío", () => {
    expect(() => construirEnvioRecibos({ rutResponde: RUT_KIUBO, rutRecibe: RUT_PROVEEDOR }, [{ ...recibo(1), tipoDoc: 43 }], CERT, AHORA))
      .toThrow(/tipo 43/);
    expect(() => construirEnvioRecibos({ rutResponde: RUT_KIUBO, rutRecibe: RUT_PROVEEDOR }, [{ ...recibo(1), recinto: "  " }], CERT, AHORA))
      .toThrow(/recinto/);
  });

  it("se serializa en ISO-8859-1: la Ñ del recinto es un byte", () => {
    const bytes = serializarEnvioRecibos({ rutResponde: RUT_KIUBO, rutRecibe: RUT_PROVEEDOR }, [recibo(41)], CERT, AHORA);
    expect(bytes.toString("latin1")).toMatch(/^<\?xml version="1\.0" encoding="ISO-8859-1"\?>/);
    expect(bytes.includes(Buffer.from("BODEGA \xd1U\xd1OA", "latin1"))).toBe(true);
  });
});
