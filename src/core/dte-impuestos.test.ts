import { describe, expect, it } from "vitest";
import { clasificarImpuestos } from "./dte-impuestos";

describe("clasificarImpuestos (campo 124 del SII)", () => {
  it("el ILA suma, la retención resta y un código fuera de la tabla queda aparte", () => {
    expect(
      clasificarImpuestos([
        { codigo: 26, monto: 205 }, // cerveza: suma
        { codigo: 271, monto: 180 }, // bebida alto en azúcar: suma
        { codigo: 15, monto: 190 }, // IVA retenido total (factura de compra): resta
        { codigo: 999, monto: 1 },
        { codigo: 999, monto: 2 },
      ]),
    ).toEqual({ adicionales: 385, retenciones: 190, desconocidos: [999, 999] });
  });

  it("sin impuestos no hay nada que sumar ni restar", () => {
    expect(clasificarImpuestos([])).toEqual({ adicionales: 0, retenciones: 0, desconocidos: [] });
  });
});
