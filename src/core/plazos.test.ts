import { describe, expect, it } from "vitest";
import { situacionPlazo, vencimientoPlazo } from "./plazos";

const RECEPCION = "2026-10-01T10:00:00-03:00";
const base = { tipoDte: 33, fechaRecepcionSii: RECEPCION, evento: null };

describe("plazo de 8 días corridos desde la recepción en el SII", () => {
  it("vence exactamente 8×24 h después de la recepción", () => {
    expect(vencimientoPlazo(RECEPCION).toISOString()).toBe("2026-10-09T13:00:00.000Z");
  });

  it("vigente, por vencer y aceptado tácito según la hora", () => {
    expect(situacionPlazo({ ...base, ahora: new Date("2026-10-03T10:00:00-03:00") }).estado).toBe("vigente");
    const por = situacionPlazo({ ...base, ahora: new Date("2026-10-08T10:00:00-03:00"), horasAviso: 48 });
    expect(por).toMatchObject({ estado: "por_vencer", horasRestantes: 24 });
    expect(situacionPlazo({ ...base, ahora: new Date("2026-10-09T10:00:01-03:00") }).estado).toBe("aceptado_tacito");
  });

  it("un evento manda sobre el reloj", () => {
    const tarde = new Date("2026-12-01T00:00:00Z");
    expect(situacionPlazo({ ...base, evento: "RFT", ahora: tarde }).estado).toBe("reclamado");
    expect(situacionPlazo({ ...base, evento: "ERM", ahora: tarde }).estado).toBe("aceptado");
  });

  it("sin recepción NO declara vencido: da una cota desde la emisión", () => {
    const s = situacionPlazo({ ...base, fechaRecepcionSii: null, fechaEmision: "2026-10-01", ahora: new Date("2027-01-01T00:00:00Z") });
    expect(s).toEqual({ estado: "sin_fecha", vence: null, venceNoAntesDe: "2026-10-09T00:00:00.000Z", horasRestantes: null });
  });

  it("los tipos sin registro (61, 52, 39) no tienen plazo", () => {
    expect(situacionPlazo({ ...base, tipoDte: 61, ahora: new Date() }).estado).toBe("no_aplica");
  });
});
