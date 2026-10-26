import { describe, expect, it } from "vitest";
import { createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import {
  extraerTed,
  verificarFirmaTed,
  verificarSinCaracteresDeControl,
  verificarTotales,
} from "./dte-ted";

// Verificación LOCAL del timbre: lo más cerca del SII que se puede llegar sin el SII. El TED lleva
// la llave pública ADENTRO (el <CAF> viaja embebido en el <DD>), así que se puede comprobar que la
// firma corresponde al documento sin preguntarle a nadie.
//
// OJO con lo que esto NO prueba: que el SII acepte. <FRMT> es NUESTRA firma del timbre; <FRMA> es
// la del SII sobre el CAF, y con un CAF sintético esa no es auténtica.

/** Arma un DTE de juguete con un TED bien firmado, como el que produce el motor. */
function dteConTedValido(opts: { mentirEnLaFirma?: boolean } = {}) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 512 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  const jwk = createPublicKey(pem).export({ format: "jwk" }) as { n: string; e: string };
  const b64 = (x: string) => Buffer.from(x, "base64url").toString("base64");

  const dd =
    `<DD><RE>76543210-3</RE><TD>33</TD><F>1</F><FE>2026-08-06</FE>` +
    `<RR>8636080-2</RR><RSR>CLIENTE SPA</RSR><MNT>1190</MNT><IT1>PAN</IT1>` +
    `<CAF version="1.0"><DA><RE>76543210-3</RE><RS>EMISOR</RS><TD>33</TD>` +
    `<RNG><D>1</D><H>50</H></RNG><FA>2026-08-01</FA>` +
    `<RSAPK><M>${b64(jwk.n)}</M><E>${b64(jwk.e)}</E></RSAPK><IDK>300</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">firma-del-sii</FRMA></CAF>` +
    `<TSTED>2026-08-06T10:00:00</TSTED></DD>`;

  const firmador = createSign("RSA-SHA1");
  firmador.update(Buffer.from(opts.mentirEnLaFirma ? dd.replace("1190", "9999") : dd, "latin1"));
  const frmt = firmador.sign(pem).toString("base64");

  return `<?xml version="1.0" encoding="ISO-8859-1"?><DTE version="1.0"><Documento>` +
    `<Totales><MntNeto>1000</MntNeto><IVA>190</IVA><MntTotal>1190</MntTotal></Totales>` +
    `<TED version="1.0">${dd}<FRMT algoritmo="SHA1withRSA">${frmt}</FRMT></TED></Documento></DTE>`;
}

describe("extraerTed", () => {
  it("devuelve el bloque <TED> VERBATIM: espacios, tabs y saltos raros sobreviven byte a byte", () => {
    // La firma <FRMT> se calculó sobre estos bytes exactos: "normalizar" el espaciado al extraer
    // rompería la validación del timbre que se imprime. El fixture mete a propósito CRLF, tab,
    // espacios dobles y espacios colgando dentro del bloque.
    const ted =
      '<TED version="1.0">\r\n' +
      "  <DD><RE>76543210-3</RE>  <F>7</F>\t<TSTED>2026-08-06T10:00:00</TSTED> </DD>\n" +
      '  <FRMT algoritmo="SHA1withRSA">aG9s YQ==  </FRMT>\n' +
      "</TED>";
    const xml =
      `<?xml version="1.0" encoding="ISO-8859-1"?><DTE version="1.0"><Documento>` +
      `<Encabezado><FchEmis>2026-08-06</FchEmis></Encabezado>${ted}</Documento></DTE>`;
    expect(extraerTed(xml)).toBe(ted);
  });

  it("extrae el TED de un DTE real del motor (el mismo que valida la firma)", () => {
    const xml = dteConTedValido();
    const ted = extraerTed(xml);
    expect(ted.startsWith('<TED version="1.0">')).toBe(true);
    expect(ted.endsWith("</TED>")).toBe(true);
    // Verbatim de verdad: el bloque extraído es substring literal del documento.
    expect(xml).toContain(ted);
  });

  it("un documento sin timbre corta con error explícito, no con un string vacío", () => {
    expect(() => extraerTed("<DTE><Documento></Documento></DTE>")).toThrow(/no está timbrado/);
  });
});

describe("verificarFirmaTed", () => {
  it("acepta un timbre bien firmado contra la llave que el propio documento publica", () => {
    expect(verificarFirmaTed(dteConTedValido())).toEqual({ valido: true });
  });

  it("detecta una firma que no corresponde al documento", () => {
    // Se firmó otro contenido: es lo que pasaría si el <DD> se corrompe después de firmar.
    const r = verificarFirmaTed(dteConTedValido({ mentirEnLaFirma: true }));
    expect(r.valido).toBe(false);
    if (!r.valido) expect(r.motivo).toMatch(/no corresponde/);
  });

  it("detecta que el <DD> fue alterado después de firmar", () => {
    // El caso real: un escapado que corrompe el bloque, o un truncado que parte una entidad.
    const alterado = dteConTedValido().replace("<MNT>1190</MNT>", "<MNT>9999</MNT>");
    expect(verificarFirmaTed(alterado).valido).toBe(false);
  });

  it("un documento sin timbre lo dice, en vez de fallar oscuro", () => {
    const r = verificarFirmaTed("<DTE><Documento></Documento></DTE>");
    expect(r.valido).toBe(false);
    if (!r.valido) expect(r.motivo).toMatch(/no está timbrado/);
  });

  it("un CAF cuyo <RSAPK> no es una llave RSA se reporta como tal", () => {
    // Es exactamente el defecto que tenían nuestros propios fixtures: un módulo de 23 bytes.
    const roto = dteConTedValido().replace(
      /<M>[^<]*<\/M>/,
      "<M>rAHSf1bzAIOSJDAISJDIVmuQA6WMxfQ==</M>",
    );
    const r = verificarFirmaTed(roto);
    expect(r.valido).toBe(false);
  });
});

describe("verificarTotales", () => {
  it("acepta un documento que cuadra consigo mismo", () => {
    expect(verificarTotales(dteConTedValido())).toEqual({ valido: true });
  });

  it("detecta el descuadre, que el SII NO rechaza pero es un error igual", () => {
    const r = verificarTotales(
      "<Totales><MntNeto>1000</MntNeto><IVA>190</IVA><MntTotal>1191</MntTotal></Totales>",
    );
    expect(r.valido).toBe(false);
    if (!r.valido) expect(r.motivo).toMatch(/1191/);
  });

  it("cuenta los impuestos adicionales en la suma", () => {
    const xml =
      "<Totales><MntNeto>1000</MntNeto><IVA>190</IVA>" +
      "<ImptoReten><TipoImp>26</TipoImp><TasaImp>20.5</TasaImp><MontoImp>205</MontoImp></ImptoReten>" +
      "<MntTotal>1395</MntTotal></Totales>";
    expect(verificarTotales(xml)).toEqual({ valido: true });
  });

  it("suma VARIOS bloques de impuesto, no sólo el primero", () => {
    const xml =
      "<Totales><MntNeto>2000</MntNeto><IVA>380</IVA>" +
      "<ImptoReten><TipoImp>26</TipoImp><TasaImp>20.5</TasaImp><MontoImp>205</MontoImp></ImptoReten>" +
      "<ImptoReten><TipoImp>24</TipoImp><TasaImp>31.5</TasaImp><MontoImp>315</MontoImp></ImptoReten>" +
      "<MntTotal>2900</MntTotal></Totales>";
    expect(verificarTotales(xml)).toEqual({ valido: true });
  });

  it("la retención de una factura de compra (15) RESTA del total", () => {
    // Factura de compra 46 con IVA retenido total: el vendedor recibe solo el neto.
    const xml =
      "<Totales><MntNeto>1000</MntNeto><IVA>190</IVA>" +
      "<ImptoReten><TipoImp>15</TipoImp><TasaImp>19</TasaImp><MontoImp>190</MontoImp></ImptoReten>" +
      "<MntTotal>1000</MntTotal></Totales>";
    expect(verificarTotales(xml)).toEqual({ valido: true });
  });

  it("un código fuera de la tabla del SII no se puede cuadrar", () => {
    const xml =
      "<Totales><MntNeto>1000</MntNeto><IVA>190</IVA>" +
      "<ImptoReten><TipoImp>999</TipoImp><MontoImp>10</MontoImp></ImptoReten>" +
      "<MntTotal>1200</MntTotal></Totales>";
    const r = verificarTotales(xml);
    expect(r.valido).toBe(false);
    if (!r.valido) expect(r.motivo).toMatch(/999/);
  });
});

describe("verificarSinCaracteresDeControl", () => {
  it("acepta un documento limpio", () => {
    expect(verificarSinCaracteresDeControl(Buffer.from("<DTE>ok</DTE>\n"))).toEqual({ valido: true });
  });

  it("detecta el byte de control que dejaba una comilla tipográfica de Excel", () => {
    const r = verificarSinCaracteresDeControl(Buffer.from([0x3c, 0x41, 0x1c, 0x3e]));
    expect(r.valido).toBe(false);
    if (!r.valido) expect(r.motivo).toMatch(/0x1c/);
  });
});
