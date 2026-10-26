import { describe, expect, it } from "vitest";
import { clasificarEstadoDte, fechaDdmmaaaa, parsearEstadoDte, sobreEstadoDte } from "./estado-dte";

const CONSULTA = {
  rutConsultante: "11598736-4",
  rutEmisor: "76086428-5",
  rutReceptor: "77840802-3",
  tipoDte: 33,
  folio: 1234,
  fechaEmision: "2026-10-01",
  montoTotal: 11900,
};

/** Respuesta en la forma del manual (figura 3-5): XML escapado dentro de getEstDteReturn. */
const respuesta = (interior: string) =>
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>` +
  `<ns1:getEstDteResponse xmlns:ns1="https://palena.sii.cl/DTEWS/QueryEstDte.jws"><getEstDteReturn xsi:type="xsd:string">` +
  interior.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
  `</getEstDteReturn></ns1:getEstDteResponse></soapenv:Body></soapenv:Envelope>`;

describe("QueryEstDte", () => {
  it("arma los 11 parámetros con la fecha en DDMMAAAA", () => {
    const x = sobreEstadoDte(CONSULTA, "TOK123");
    expect(x).toContain("<RutConsultante>11598736</RutConsultante><DvConsultante>4</DvConsultante>");
    expect(x).toContain("<RutCompania>76086428</RutCompania><DvCompania>5</DvCompania>");
    expect(x).toContain("<RutReceptor>77840802</RutReceptor><DvReceptor>3</DvReceptor>");
    expect(x).toContain("<FechaEmisionDte>01102026</FechaEmisionDte><MontoDte>11900</MontoDte><Token>TOK123</Token>");
  });

  it("no deja entrar un token con caracteres de XML", () => {
    expect(() => sobreEstadoDte(CONSULTA, "a<b")).toThrow(/token/);
    expect(() => fechaDdmmaaaa("01-10-2026")).toThrow();
  });

  it("lee el ejemplo del manual (DNK, figura 3-5)", () => {
    const r = parsearEstadoDte(
      respuesta(
        `<?xml version="1.0" encoding="UTF-8"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"><SII:RESP_HDR>` +
          `<ESTADO>DNK</ESTADO><GLOSA>DTE Recibido</GLOSA><ERR_CODE>1</ERR_CODE>` +
          `<GLOSA_ERR>Documento Recibido por el SII pero Datos NO Coinciden con los registrados</GLOSA_ERR> ` +
          `<NUM_ATENCION>532   ( 2004/06/14 16:44:20)</NUM_ATENCION></SII:RESP_HDR></SII:RESPUESTA>`,
      ),
    );
    expect(r).toMatchObject({ estado: "DNK", clase: "no_coincide", glosa: "DTE Recibido", errCode: "1" });
    expect(r!.numAtencion).toContain("532");
  });

  it("acepta GLOSA_ESTADO (la forma de los ejemplos del capítulo 4)", () => {
    const r = parsearEstadoDte(respuesta(`<SII:RESP_HDR><ESTADO>TMD</ESTADO><GLOSA_ESTADO>DTE Recibido</GLOSA_ESTADO><ERR_CODE>10</ERR_CODE></SII:RESP_HDR>`));
    expect(r).toMatchObject({ estado: "TMD", clase: "valido", glosa: "DTE Recibido" });
  });

  it("clasifica: anulados, no recibido, token y desconocido (nunca válido por defecto)", () => {
    expect(clasificarEstadoDte("DOK")).toBe("valido");
    expect(clasificarEstadoDte("ANC")).toBe("anulado");
    expect(clasificarEstadoDte("FAU")).toBe("no_recibido");
    expect(clasificarEstadoDte("EMP")).toBe("invalido");
    expect(clasificarEstadoDte("002")).toBe("token");
    expect(clasificarEstadoDte("-3")).toBe("desconocido");
  });

  it("sin ESTADO no hay estado", () => {
    expect(parsearEstadoDte("<html>error</html>")).toBeNull();
  });

});
