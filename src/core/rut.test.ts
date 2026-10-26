import { describe, it, expect } from "vitest";
import {
  isValidRut,
  formatRut,
  computeDv,
  cleanRut,
  RUT_CONSUMIDOR_GENERICO,
  RUT_RECEPTOR_SII,
} from "./rut";

describe("computeDv (mod-11, ciclo 2..7)", () => {
  it("76086428 → 5", () => expect(computeDv(76086428)).toBe("5"));
  it("60803000 → K", () => expect(computeDv(60803000)).toBe("K"));
  it("66666666 → 6", () => expect(computeDv(66666666)).toBe("6"));
});

describe("isValidRut", () => {
  it("acepta RUTs válidos en cualquier formato", () => {
    expect(isValidRut("76.086.428-5")).toBe(true);
    expect(isValidRut("760864285")).toBe(true);
    expect(isValidRut("60.803.000-k")).toBe(true);
    expect(isValidRut(RUT_CONSUMIDOR_GENERICO)).toBe(true);
    expect(isValidRut(RUT_RECEPTOR_SII)).toBe(true);
  });
  it("rechaza DV incorrecto", () => {
    expect(isValidRut("76.086.428-4")).toBe(false);
    expect(isValidRut("60.803.000-9")).toBe(false);
  });
  it("rechaza basura / vacío / cuerpo no numérico", () => {
    expect(isValidRut("")).toBe(false);
    expect(isValidRut("abc")).toBe(false);
    expect(isValidRut("1")).toBe(false);
    expect(isValidRut("12.34X.567-8")).toBe(false);
  });
});

describe("formatRut", () => {
  it("inserta puntos y guion", () => {
    expect(formatRut("760864285")).toBe("76.086.428-5");
    expect(formatRut("60803000k")).toBe("60.803.000-K");
  });
  it("cleanRut quita puntos/guion/espacios y sube la K", () => {
    expect(cleanRut(" 60.803.000-k ")).toBe("60803000K");
  });
});
