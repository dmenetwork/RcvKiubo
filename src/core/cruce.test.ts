import { describe, expect, it } from "vitest";
import { cruzar } from "./cruce";

const d = (folio: number, montoTotal?: number, fechaEmision?: string) => ({
  rutContraparte: "76086428-5",
  tipoDte: 33,
  folio,
  montoTotal,
  fechaEmision,
});

describe("cruzar", () => {
  it("separa lo que está sólo en un lado, lo que difiere y lo que coincide", () => {
    const r = cruzar([d(1, 100), d(2, 200), d(3, 300, "2026-10-01")], [d(2, 200), d(3, 300, "2026-10-02"), d(4, 400)]);
    expect(r.soloEnA.map((x) => x.folio)).toEqual([1]);
    expect(r.soloEnB.map((x) => x.folio)).toEqual([4]);
    expect(r.diferencias).toHaveLength(1);
    expect(r.diferencias[0]!.campos).toEqual(["fechaEmision"]);
    expect(r.coinciden).toBe(1);
  });

  it("un monto ausente en un lado no es diferencia", () => {
    expect(cruzar([d(1, 100)], [d(1)]).coinciden).toBe(1);
  });

  it("el mismo folio de OTRO tipo u otro proveedor es otro documento", () => {
    const r = cruzar([d(1, 100)], [{ ...d(1, 100), tipoDte: 61 }, { ...d(1, 100), rutContraparte: "77840802-3" }]);
    expect(r.soloEnA).toHaveLength(1);
    expect(r.soloEnB).toHaveLength(2);
  });

  it("informa duplicados dentro de un lado", () => {
    expect(cruzar([d(1), d(1)], []).duplicadosA).toEqual(["76086428-5|33|1"]);
  });
});
