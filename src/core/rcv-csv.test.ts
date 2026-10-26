import { describe, expect, it } from "vitest";
import { entero, metadatosDeNombre, normalizarEncabezado, parsearRcvCsv, partirLinea } from "./rcv-csv";

const ENC_COMPRAS =
  "Nro;Tipo Doc;Tipo Compra;RUT Proveedor;Razon Social;Folio;Fecha Docto;Fecha Recepcion;Fecha Acuse;" +
  "Monto Exento;Monto Neto;Monto IVA Recuperable;Monto Iva No Recuperable;Codigo IVA No Rec.;Monto Total;" +
  "Monto Neto Activo Fijo;IVA Activo Fijo;IVA uso Comun;Impto. Sin Derecho a Credito;IVA No Retenido;" +
  "Tabacos Puros;Tabacos Cigarrillos;Tabacos Elaborados;NCE o NDE sobre Fact. de Compra;" +
  "Codigo Otro Impuesto;Valor Otro Impuesto;Tasa Otro Impuesto";

const fila = (cols: Record<number, string>) => {
  const celdas = Array(27).fill("");
  for (const [i, v] of Object.entries(cols)) celdas[Number(i)] = v;
  return celdas.join(";");
};

describe("parsearRcvCsv: compras", () => {
  const csv = [
    ENC_COMPRAS,
    fila({ 0: "1", 1: "33", 2: "Del Giro", 3: "76086428-5", 4: "COMERCIAL ÑANDÚ LTDA", 5: "1234", 6: "01/10/2026", 7: "01/10/2026 10:15:30", 9: "0", 10: "20000", 11: "3800", 14: "29000", 24: "25", 25: "4100", 26: "20,5" }),
    fila({ 0: "2", 1: "61", 3: "76086428-5", 4: "COMERCIAL", 5: "88", 6: "05/10/2026", 10: "1000", 11: "190", 14: "1190" }),
    fila({ 0: "3", 1: "33", 3: "76086428-4", 5: "1" }), // DV malo
    "",
  ].join("\r\n");

  const r = parsearRcvCsv(Buffer.from(csv, "latin1"));

  it("detecta compras por la columna del RUT del proveedor", () => {
    expect(r.operacion).toBe("COMPRA");
  });

  it("lee montos enteros, fechas chilenas, la recepción con hora y los otros impuestos (ILA)", () => {
    expect(r.filas[0]).toMatchObject({
      linea: 2,
      tipoDte: 33,
      rutContraparte: "76086428-5",
      razonSocial: "COMERCIAL ÑANDÚ LTDA",
      folio: 1234,
      fechaEmision: "2026-10-01",
      fechaRecepcionSii: "2026-10-01T10:15:30-03:00",
      montoNeto: 20000,
      montoIva: 3800,
      montoTotal: 29000,
      otrosImpuestos: [{ codigo: 25, valor: 4100, tasa: 20.5 }],
    });
    expect(r.filas[1]).toMatchObject({ tipoDte: 61, folio: 88, montoTotal: 1190, otrosImpuestos: [] });
  });

  it("una fila mala no detiene el archivo: queda como problema con su línea", () => {
    expect(r.filas).toHaveLength(2);
    expect(r.problemas).toEqual([{ linea: 4, motivo: expect.stringMatching(/RUT inválido/) }]);
  });

  it("las columnas sin campo propio van a extra sólo si traen valor", () => {
    expect(r.columnasDesconocidas).toContain("Tabacos Puros");
    expect(r.filas[0]!.tipoTransaccion).toBe("Del Giro");
    expect(r.filas[0]!.extra).toEqual({});
    const conTabaco = parsearRcvCsv([ENC_COMPRAS, fila({ 1: "33", 3: "76086428-5", 5: "9", 21: "350" })].join("\n"));
    expect(conTabaco.filas[0]!.extra).toEqual({ "Tabacos Cigarrillos": "350" });
  });
});

describe("parsearRcvCsv: ventas y bordes", () => {
  it("detecta ventas y lee la fecha de reclamo", () => {
    const csv =
      "Nro;Tipo Doc;Tipo Venta;Rut cliente;Razon Social;Folio;Fecha Docto;Fecha Recepcion;Fecha Acuse Recibo;Fecha Reclamo;Monto Exento;Monto Neto;Monto IVA;Monto total\n" +
      "1;33;Del Giro;77840802-3;SOCIEDAD G Y A;55;02/10/2026;02/10/2026 11:00:00;;03/10/2026 09:00:00;0;10000;1900;11900\n";
    const r = parsearRcvCsv(csv);
    expect(r.operacion).toBe("VENTA");
    expect(r.filas[0]).toMatchObject({ rutContraparte: "77840802-3", folio: 55, montoIva: 1900, montoTotal: 11900, fechaReclamo: "2026-10-03T09:00:00-03:00" });
  });

  it("un archivo que no es del RCV falla entero, con el encabezado leído", () => {
    expect(() => parsearRcvCsv("a;b;c\n1;2;3")).toThrow(/no parece un detalle del RCV/);
    expect(() => parsearRcvCsv("")).toThrow(/vacío/);
  });

  it("decodifica UTF-8 con BOM y Latin-1", () => {
    const enc = "Tipo Doc;RUT Proveedor;Razon Social;Folio\n33;76086428-5;AZÚCAR;1\n";
    expect(parsearRcvCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(enc, "utf8")])).filas[0]!.razonSocial).toBe("AZÚCAR");
    expect(parsearRcvCsv(Buffer.from(enc, "latin1")).filas[0]!.razonSocial).toBe("AZÚCAR");
  });

  it("montos: entero, miles con punto, y basura como NaN", () => {
    expect(entero("1.234.567")).toBe(1234567);
    expect(entero("-500")).toBe(-500);
    expect(entero("")).toBeNull();
    expect(entero("12,5")).toBeNaN();
  });

  it("comillas dobles protegen el separador", () => {
    expect(partirLinea(`1;"ACME; S.A.";"dice ""hola"""`, ";")).toEqual(["1", "ACME; S.A.", 'dice "hola"']);
  });

  it("normaliza encabezados", () => {
    expect(normalizarEncabezado("Código IVA No Rec.")).toBe("codigo_iva_no_rec");
  });
});

describe("metadatosDeNombre", () => {
  it("lee operación, estado, RUT y período del nombre del portal", () => {
    expect(metadatosDeNombre("RCV_COMPRA_REGISTRO_76086428-5_202610.csv")).toEqual({
      operacion: "COMPRA", estado: "REGISTRO", rut: "76086428-5", periodo: "202610",
    });
    expect(metadatosDeNombre("RCV_VENTA_77840802-3_202609.csv")).toMatchObject({ operacion: "VENTA", estado: null, periodo: "202609" });
    expect(metadatosDeNombre("compras octubre.csv")).toMatchObject({ operacion: "COMPRA", periodo: null });
  });
});
