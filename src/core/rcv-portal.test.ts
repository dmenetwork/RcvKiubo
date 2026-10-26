import { describe, expect, it } from "vitest";
import { parsearRcvCsv } from "./rcv-csv";
import { csvRcv, detalleDesdeFila, htmlRcv } from "./rcv-formato";
import { cuerpoRcv, datosDetalle, filaDesdePortal, normalizarResumen, parsearRespuestaRcv, respuestaPideCaptcha, type FilaDetalleSii } from "./rcv-portal";

/** Formas tomadas de la respuesta REAL del portal (2026-10-26), con RUT y razón social cambiados. */
const RESUMEN_REAL = {
  dcvCodigo: 1289042859, rsmnCodigo: 3029027681, rsmnTipoDocInteger: 33, dcvNombreTipoDoc: "Factura Electrónica",
  dcvTipoIngresoDoc: "DET_ELE", rsmnLink: true, rsmnMntExe: 1278186, rsmnMntNeto: 222174846, rsmnMntIVA: 41390788,
  rsmnMntIVANoRec: 822408, rsmnIVAUsoComun: 0, dcvOperacion: null, rsmnFechModificacion: null, rsmnMntTotal: 270027691,
  rsmnEstadoContab: null, rsmnTotDoc: 426, rsmnTotalRutEmisor: null,
};
const BOLETAS_REAL = { ...RESUMEN_REAL, rsmnTipoDocInteger: 39, dcvNombreTipoDoc: "Total Oper. del mes Boleta Electr.", dcvTipoIngresoDoc: "RESUMEN", rsmnLink: false, rsmnTotDoc: 18885 };
const DETALLE_COMPRA_REAL = {
  dhdrCodigo: 9226710900, dcvCodigo: 1289042859, dcvEstadoContab: null, detCodigo: 11033331531, detTipoDoc: null,
  detRutDoc: 76086428, detDvDoc: "5", detRznSoc: "PROVEEDOR DE PRUEBA SPA", detNroDoc: 2040, detFchDoc: "30/09/2026",
  detFecAcuse: "01/10/2026 09:20:16", detFecReclamado: null, detFecRecepcion: "30/09/2026 09:34:18", detMntExe: 0,
  detMntNeto: 197521, detMntActFijo: 0, detMntIVAActFijo: 0, detMntIVANoRec: 0, detMntCodNoRec: 0, detMntSinCredito: 0,
  detMntIVA: 37529, detMntTotal: 235050, detTasaImp: null, detTipoDocRef: 0, detFolioDocRef: null, detCdgSIISucur: 0,
  detTpoImp: 1, detTipoTransaccion: 1, detEventoReceptor: "C", detEventoReceptorLeyenda: "Recibo otorgado por el receptor",
  cambiarTipoTran: true, detPcarga: 202609, descTipoTransaccion: "Del Giro", totalDtoiMontoImp: 6135, totalDinrMontoIVANoR: null,
  emisorAgresivo: false, fechaActivacionAnotacion: null,
} as unknown as FilaDetalleSii;

describe("pedidos al portal del RCV", () => {
  it("arma el cuerpo con el namespace del método y el TOKEN como conversationId", () => {
    const c = JSON.parse(cuerpoRcv("getDetalleCompra", "TOK", datosDetalle("11598736-4", "202610", "COMPRA", "REGISTRO", 33)));
    expect(c.metaData).toMatchObject({ namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompra", conversationId: "TOK", page: null });
    expect(c.data).toEqual({ rutEmisor: "11598736", dvEmisor: "4", ptributario: "202610", codTipoDoc: 33, operacion: "COMPRA", estadoContab: "REGISTRO" });
    // Nunca viaja un campo de captcha.
    expect(JSON.stringify(c)).not.toMatch(/captcha/i);
  });

  it("detecta un pedido de captcha para detenerse", () => {
    expect(respuestaPideCaptcha('{"respEstado":{"msgeRespuesta":"tokenRecaptcha no puede ser vacío"}}')).toBe(true);
    expect(respuestaPideCaptcha(JSON.stringify({ data: [], respEstado: { codRespuesta: 0 } }))).toBe(false);
  });
});

describe("respuestas del portal", () => {
  it("0 = filas; 99 'no hay documentos o diferida' = vacío; otro código = error", () => {
    expect(parsearRespuestaRcv(JSON.stringify({ data: [RESUMEN_REAL], respEstado: { codRespuesta: 0 } })).filas).toHaveLength(1);
    expect(
      parsearRespuestaRcv(JSON.stringify({ data: null, respEstado: { codRespuesta: 99, msgeRespuesta: "No es posible realizar esta consulta, no hay documentos o debe ser de forma diferida" } })).filas,
    ).toEqual([]);
    expect(() => parsearRespuestaRcv(JSON.stringify({ respEstado: { codRespuesta: 2, msgeRespuesta: "Sesión inválida" } }))).toThrow(/Sesión inválida/);
    expect(() => parsearRespuestaRcv("<html>login</html>")).toThrow(/no devolvió JSON/);
  });

  it("el resumen: las boletas vienen sólo como total (sin detalle)", () => {
    expect(normalizarResumen(RESUMEN_REAL)).toMatchObject({ tipoDte: 33, tieneDetalle: true, totalDocumentos: 426, montoTotal: 270027691, montoIvaNoRecuperable: 822408 });
    expect(normalizarResumen(BOLETAS_REAL)).toMatchObject({ tipoDte: 39, tieneDetalle: false, totalDocumentos: 18885 });
  });

  it("el detalle queda en la misma forma que una fila del CSV", () => {
    const f = filaDesdePortal(DETALLE_COMPRA_REAL, 33, 1);
    expect(f).toMatchObject({
      tipoDte: 33, rutContraparte: "76086428-5", razonSocial: "PROVEEDOR DE PRUEBA SPA", folio: 2040, fechaEmision: "2026-09-30",
      fechaRecepcionSii: "2026-09-30T09:34:18-03:00", fechaAcuse: "2026-10-01T09:20:16-03:00", fechaReclamo: null,
      tipoTransaccion: "Del Giro", montoNeto: 197521, montoIva: 37529, montoTotal: 235050,
    });
    const extra = (f as { extra: Record<string, string> }).extra;
    expect(extra).toMatchObject({ detEventoReceptor: "C", detEventoReceptorLeyenda: "Recibo otorgado por el receptor", totalDtoiMontoImp: "6135" });
    // Los identificadores internos del SII no se guardan.
    expect(extra.dhdrCodigo).toBeUndefined();
  });

  it("una fila sin RUT o folio válidos se informa, no se inventa", () => {
    expect(filaDesdePortal({ ...DETALLE_COMPRA_REAL, detDvDoc: "9" }, 33, 1)).toMatch(/RUT inválido/);
    expect(filaDesdePortal({ ...DETALLE_COMPRA_REAL, detNroDoc: null }, 33, 1)).toMatch(/folio/);
  });
});

describe("el RCV en el formato del SII", () => {
  const fila = filaDesdePortal(DETALLE_COMPRA_REAL, 33, 1) as Exclude<ReturnType<typeof filaDesdePortal>, string>;
  const det = detalleDesdeFila(fila, false);

  it("la vista lleva el evento del receptor y el total de otros impuestos", () => {
    expect(det).toMatchObject({ evento: "Recibo otorgado por el receptor", otrosImpuestos: 6135, enXml: false });
  });

  it("el CSV exportado tiene las columnas del portal y lo vuelve a leer el import", () => {
    const csv = csvRcv("COMPRA", [det]);
    expect(csv.split("\r\n")[1]).toBe("1;33;Del Giro;76086428-5;PROVEEDOR DE PRUEBA SPA;2040;30/09/2026;30/09/2026 09:34:18;01/10/2026 09:20:16;0;197521;37529;0;;235050;6135");
    const vuelta = parsearRcvCsv(csv);
    expect(vuelta.operacion).toBe("COMPRA");
    expect(vuelta.filas[0]).toMatchObject({ folio: 2040, montoTotal: 235050, fechaRecepcionSii: "2026-09-30T09:34:18-03:00" });
  });

  it("la página tiene el resumen con totales, el detalle y marca lo que no llegó al buzón", () => {
    const html = htmlRcv({
      rut: "11598736-4",
      razonSocial: "SUPERMERCADO <BELÉN>",
      periodo: "202610",
      sincronizadoEn: "2026-10-26T12:00:00",
      secciones: [{ operacion: "COMPRA", estado: "REGISTRO", resumen: [{ ...normalizarResumen(RESUMEN_REAL) }], detalle: [det] }],
    });
    expect(html).toContain("RUT 11.598.736-4 · Período 10/2026");
    expect(html).toContain("SUPERMERCADO &lt;BELÉN&gt;");
    expect(html).toContain("<td>270.027.691</td>");
    expect(html).toContain('class="sinxml"');
    expect(html).toContain("76.086.428-5");
  });

  it("en el total del resumen las notas de crédito restan", () => {
    const nc = { ...normalizarResumen(RESUMEN_REAL), tipoDte: 61, nombreTipoDoc: "Nota de Crédito Electrónica", totalDocumentos: 88, montoNeto: 6_168_443, montoIva: 1_165_391, montoTotal: 7_864_411 };
    const html = htmlRcv({ rut: "11598736-4", razonSocial: null, periodo: "202610", sincronizadoEn: null, secciones: [{ operacion: "COMPRA", estado: "REGISTRO", resumen: [normalizarResumen(RESUMEN_REAL), nc], detalle: [] }] });
    const total = /<tr class="total">(.*?)<\/tr>/.exec(html)![1]!;
    // 270.027.691 − 7.864.411 = 262.163.280; IVA 41.390.788 − 1.165.391 = 40.225.397; documentos se suman.
    expect(total).toContain("<td>262.163.280</td>");
    expect(total).toContain("<td>40.225.397</td>");
    expect(total).toContain("<td>514</td>");
    expect(html).toContain("Nota de Crédito Electrónica (61) — resta");
  });
});
