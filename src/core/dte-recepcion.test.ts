import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_BYTES_ENVIO,
  RecepcionInvalidaError,
  claveDedupRecibido,
  parsearDteFirmado,
  parsearEnvioDte,
  parsearFechaRecepcionSii,
  revisarTotales,
  type DteRecibido,
} from "./dte-recepcion";
import { serializarSobre } from "./__fixtures__/dte-sobre";
import {
  RUT_KIUBO,
  RUT_PROVEEDOR,
  cafDePrueba,
  certificadoDePrueba,
  dteDePrueba,
  llaveSiiDePrueba,
} from "./__fixtures__/material";

const CERT = certificadoDePrueba();
const SII = llaveSiiDePrueba();
const CAF = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: SII.privada });

const REF_OC = `<Referencia><NroLinRef>1</NroLinRef><TpoDocRef>801</TpoDocRef><FolioRef>OC-4471</FolioRef>` +
  `<FchRef>2026-09-28</FchRef><RazonRef>ORDEN DE COMPRA &amp; DESPACHO</RazonRef></Referencia>\n`;

/** Un `<EnvioDTE>` de tres facturas, armado y firmado con el sobre de Kiubo, en bytes ISO-8859-1. */
function sobreDeTres(): Buffer {
  const dtes = [
    dteDePrueba({ folio: 11 }, CAF, CERT),
    // Factura de un proveedor de licores: ILA vinos (25) y licores (24) SUMAN al total.
    dteDePrueba({ folio: 12, neto: 20_000, impuestos: [{ codigo: 25, tasa: 20.5, monto: 2050 }, { codigo: 24, tasa: 31.5, monto: 3150 }] }, CAF, CERT),
    dteDePrueba({ folio: 13, neto: 5000, referenciasXml: REF_OC }, CAF, CERT),
  ];
  return serializarSobre(
    dtes.map((xml) => ({ tipoDte: 33, xml })),
    { rutEmisor: RUT_PROVEEDOR, rutEnvia: "11598736-4", rutReceptor: RUT_KIUBO, fechaResolucion: "2014-08-22", numeroResolucion: "80" },
    CERT,
    new Date("2026-10-01T13:00:00Z"),
    "dte",
  );
}

describe("parsearEnvioDte: cada <DTE> del sobre", () => {
  const bytes = sobreDeTres();
  const envio = parsearEnvioDte(bytes);

  it("devuelve los TRES documentos, no sólo el primero (el bug de api-facturacion)", () => {
    expect(envio.dtes.map((d) => d.folio)).toEqual([11, 12, 13]);
    expect(envio.dtes.every((d) => d.problemas.length === 0)).toBe(true);
  });

  it("lee la carátula, el ID del SetDTE y el digest del SOBRE (no el del primer documento)", () => {
    expect(envio.caratula).toEqual({
      rutEmisor: RUT_PROVEEDOR, rutEnvia: "11598736-4", rutReceptor: RUT_KIUBO,
      fchResol: "2014-08-22", nroResol: "80", tmstFirmaEnv: "2026-10-01T10:00:00",
    });
    expect(envio.setDteId).toBe("SetDte");
    const texto = bytes.toString("latin1");
    const digestDelSobre = /<DigestValue>([^<]+)<\/DigestValue>/.exec(texto.slice(texto.lastIndexOf("</SetDTE>")))?.[1];
    const digestDelPrimero = /<DigestValue>([^<]+)<\/DigestValue>/.exec(texto)?.[1];
    expect(envio.digestSobre).toBe(digestDelSobre);
    expect(envio.digestSobre).not.toBe(digestDelPrimero);
  });

  it("custodia cada <DTE> exacto como llegó, con su sha256 sobre los bytes Latin-1", () => {
    const texto = bytes.toString("latin1");
    for (const d of envio.dtes) {
      expect(texto).toContain(d.xml);
      expect(d.xml.startsWith("<DTE version=\"1.0\">") && d.xml.endsWith("</DTE>")).toBe(true);
      expect(d.sha256).toBe(createHash("sha256").update(Buffer.from(d.xml, "latin1")).digest("hex"));
    }
    expect(envio.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(envio.codificacion).toBe("latin1");
  });

  it("lee el encabezado con la Ñ y las comillas resueltas", () => {
    const [d] = envio.dtes;
    expect(d).toMatchObject({
      tipoDte: 33, fchEmis: "2026-10-01", rutEmisor: RUT_PROVEEDOR, rutRecep: RUT_KIUBO,
      rznSoc: 'COMERCIAL ÑANDÚ "LA ESTRELLA" LTDA', giroEmis: "DISTRIBUCIÓN DE ABARROTES",
      mntNeto: 10_000, iva: 1900, mntTotal: 11_900,
    });
  });

  it("lee los impuestos adicionales y la referencia a la OC (801)", () => {
    expect(envio.dtes[1].imptoReten).toEqual([
      { codigo: 25, tasa: 20.5, monto: 2050 },
      { codigo: 24, tasa: 31.5, monto: 3150 },
    ]);
    expect(envio.dtes[2].referencias).toEqual([
      { tpoDocRef: "801", folioRef: "OC-4471", fchRef: "2026-09-28", codRef: null, razonRef: "ORDEN DE COMPRA & DESPACHO" },
    ]);
  });

  it("un <DTE> roto no tumba a sus hermanos: sale con problemas", () => {
    const roto = bytes.toString("latin1").replace("<Folio>12</Folio>", "<Folio>doce</Folio>");
    const r = parsearEnvioDte(Buffer.from(roto, "latin1"));
    expect(r.dtes).toHaveLength(3);
    expect(r.dtes[1].folio).toBeNull();
    expect(r.dtes[1].problemas.join(" ")).toMatch(/Folio/);
    expect(r.dtes[0].problemas).toEqual([]);
  });

  it("un <DTE> suelto (sin sobre) se lee, sin carátula", () => {
    const suelto = parsearEnvioDte(dteDePrueba({ folio: 7 }, CAF, CERT));
    expect(suelto.caratula).toBeNull();
    expect(suelto.setDteId).toBeNull();
    expect(suelto.dtes[0].folio).toBe(7);
  });

  it("respeta un archivo que declara UTF-8", () => {
    const utf8 = `<?xml version="1.0" encoding="UTF-8"?>\n${dteDePrueba({ folio: 8 }, CAF, CERT)}`;
    const r = parsearEnvioDte(Buffer.from(utf8, "utf8"));
    expect(r.codificacion).toBe("utf8");
    expect(r.dtes[0].rznSoc).toBe('COMERCIAL ÑANDÚ "LA ESTRELLA" LTDA');
  });

  // La lectura es lineal (core/xml-lineal) y elige el contenido que aparece primero, como la
  // alternativa del regex que reemplazó.
  const conContenido = (tag: string, folio: number) =>
    `<DTE version="1.0"><${tag} ID="X"><Encabezado><IdDoc><TipoDTE>43</TipoDTE><Folio>${folio}</Folio></IdDoc>` +
    `<Emisor><RUTEmisor>${RUT_PROVEEDOR}</RUTEmisor></Emisor><Receptor><RUTRecep>${RUT_KIUBO}</RUTRecep></Receptor>` +
    `</Encabezado></${tag}></DTE>`;

  it.each(["Liquidacion", "Exportaciones"])("lee un DTE con <%s> en vez de <Documento>", (tag) => {
    const r = parsearEnvioDte(conContenido(tag, 5));
    expect(r.dtes[0]).toMatchObject({ tipoDte: 43, folio: 5, problemas: [] });
  });

  it("si vienen dos contenidos, gana el que aparece primero", () => {
    const xml = conContenido("Liquidacion", 6).replace("</Liquidacion>", "</Liquidacion><Documento><Encabezado><IdDoc><Folio>99</Folio></IdDoc></Encabezado></Documento>");
    expect(parsearEnvioDte(xml).dtes[0].folio).toBe(6);
  });

  it("el ID del SetDTE se lee de la apertura aunque el sobre no traiga el cierre", () => {
    const sinCierre = `<EnvioDTE><SetDTE ID="SetAbierto">${dteDePrueba({ folio: 9 }, CAF, CERT)}`;
    expect(parsearEnvioDte(sinCierre).setDteId).toBe("SetAbierto");
  });

  it("maxDtes corta la lectura antes de parsear y avisa que truncó", () => {
    const dos = parsearEnvioDte(sobreDeTres(), { maxDtes: 2 });
    expect(dos.dtes.map((d) => d.folio)).toEqual([11, 12]);
    expect(dos.truncado).toBe(true);
    expect(parsearEnvioDte(sobreDeTres()).truncado).toBe(false);
  });
});

describe("parsearEnvioDte: lo que no se procesa", () => {
  const motivo = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return e instanceof RecepcionInvalidaError ? e.codigo : "otro error";
    }
    return undefined;
  };

  it("rechaza un DOCTYPE o una ENTITY (XXE) antes de leer nada", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><DTE><Documento>&e;</Documento></DTE>`;
    expect(motivo(() => parsearEnvioDte(xxe))).toBe("DTD_PROHIBIDO");
    expect(motivo(() => parsearEnvioDte(`<DTE><!ENTITY a "b"></DTE>`))).toBe("DTD_PROHIBIDO");
  });

  it("rechaza más de 8 MB sin decodificarlos", () => {
    expect(motivo(() => parsearEnvioDte(Buffer.alloc(MAX_BYTES_ENVIO + 1, 0x20)))).toBe("DEMASIADO_GRANDE");
  });

  it("rechaza un archivo vacío y uno sin <DTE> (por ejemplo, una RespuestaDTE)", () => {
    expect(motivo(() => parsearEnvioDte(Buffer.alloc(0)))).toBe("VACIO");
    expect(motivo(() => parsearEnvioDte(`<RespuestaDTE><Resultado><ResultadoDTE></ResultadoDTE></Resultado></RespuestaDTE>`))).toBe("SIN_DTE");
  });
});

describe("claveDedupRecibido", () => {
  it("normaliza el RUT: con o sin puntos es el mismo documento", () => {
    expect(claveDedupRecibido("76.086.428-5", 33, 11)).toBe(claveDedupRecibido("76086428-5", 33, 11));
    expect(claveDedupRecibido("76086428-5", 33, 11)).not.toBe(claveDedupRecibido("76086428-5", 33, 12));
    expect(claveDedupRecibido("76086428-5", 33, 11)).not.toBe(claveDedupRecibido("76086428-5", 61, 11));
  });
});

describe("revisarTotales: MntTotal = neto + exento + IVA + adicionales − retenciones (formato_dte campo 124)", () => {
  const base: DteRecibido = {
    tipoDte: 33, folio: 1, fchEmis: "2026-10-01", rutEmisor: RUT_PROVEEDOR, rznSoc: "X", giroEmis: null,
    rutRecep: RUT_KIUBO, mntNeto: 10_000, mntExe: null, iva: 1900, imptoReten: [], credEc: null, grntDep: null,
    valComNeto: null, valComExe: null, valComIva: null, mntTotal: 11_900, referencias: [], xml: "", sha256: "",
    codificacion: "latin1", problemas: [],
  };

  it("factura simple cuadra", () => expect(revisarTotales(base)).toEqual([]));

  it("el ILA de una factura SUMA al total (no es informativo como en la boleta)", () => {
    const ila = { ...base, imptoReten: [{ codigo: 27, tasa: 10, monto: 1000 }], mntTotal: 12_900 };
    expect(revisarTotales(ila)).toEqual([]);
    expect(revisarTotales({ ...ila, mntTotal: 11_900 })).toHaveLength(1);
  });

  it("una retención RESTA: factura de compra 46 con IVA retenido total (15)", () => {
    const compra = { ...base, tipoDte: 46, imptoReten: [{ codigo: 15, tasa: 19, monto: 1900 }], mntTotal: 10_000 };
    expect(revisarTotales(compra)).toEqual([]);
  });

  it("exenta (34): el total es el exento", () => {
    expect(revisarTotales({ ...base, tipoDte: 34, mntNeto: null, iva: null, mntExe: 5000, mntTotal: 5000 })).toEqual([]);
  });

  it("un total que no cuadra, un código desconocido o la falta de MntTotal son problema", () => {
    expect(revisarTotales({ ...base, mntTotal: 11_901 })[0]).toMatch(/no cuadra/);
    expect(revisarTotales({ ...base, imptoReten: [{ codigo: 99, tasa: 1, monto: 1 }] })[0]).toMatch(/código 99/);
    expect(revisarTotales({ ...base, mntTotal: null })[0]).toMatch(/MntTotal/);
  });
});

describe("parsearFechaRecepcionSii: el reloj de los 8 días", () => {
  const soap = (cuerpo: string) =>
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<ns2:consultarFechaRecepcionSiiResponse xmlns:ns2="http://ws.registroreclamodte.diii.sdi.sii.cl">` +
    `${cuerpo}</ns2:consultarFechaRecepcionSiiResponse></soap:Body></soap:Envelope>`;

  it("lee dd-mm-aaaa hh:mm:ss, que es lo que de verdad devuelve el SII", () => {
    const iso = parsearFechaRecepcionSii(soap("<return>21-02-2017 19:02:03</return>"));
    expect(iso).toBe("2017-02-21T19:02:03-03:00");
    // El instante es el correcto aunque el proceso corra en UTC.
    expect(new Date(iso!).toISOString()).toBe("2017-02-21T22:02:03.000Z");
  });

  it("usa el offset de ese día (invierno = -04:00)", () => {
    expect(parsearFechaRecepcionSii(soap("<return>21-07-2017 19:02:03</return>"))).toBe("2017-07-21T19:02:03-04:00");
  });

  it("acepta el <return> con prefijo", () => {
    expect(parsearFechaRecepcionSii(soap("<ns2:return>01-10-2026 08:15:00</ns2:return>"))).toBe("2026-10-01T08:15:00-03:00");
  });

  it("sin una fecha válida devuelve null, nunca una inventada", () => {
    expect(parsearFechaRecepcionSii(soap("<return>31-02-2017 19:02:03</return>"))).toBeNull();
    // Lo que buscaba api-facturacion: el SII no responde así.
    expect(parsearFechaRecepcionSii(soap("<fechaRecepcion>2017-02-21T19:02:03</fechaRecepcion>"))).toBeNull();
    expect(parsearFechaRecepcionSii(soap("<return></return>"))).toBeNull();
    expect(parsearFechaRecepcionSii("")).toBeNull();
  });
});
