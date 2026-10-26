/**
 * El parser del padrón, contra respuestas REALES de producción.
 *
 * Las tres fixtures se capturaron el 2026-08-13 de `palena.sii.cl` (RUT 76086428-5, 61999390-K y
 * 76543210-3). Son el oráculo: un parser probado contra HTML inventado por uno mismo no prueba nada
 * — es exactamente el test tautológico que este repo prohíbe.
 *
 * Lo que se verifica, además de que parsea: que **falla cerrado**. Un `ausente` inventado porque el
 * SII cambió una plantilla haría que un ERP le entregue papel a quien espera XML, y quedaría
 * cacheado 24 horas.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formaDeEntrega, interpretarPadron } from "./padron-sii";

// ISO-8859-1: es como el SII sirve la página. Leerla como UTF-8 rompe los acentos y los rótulos.
const fixture = (nombre: string): string =>
  readFileSync(join(__dirname, "__fixtures__", "padron", nombre), "latin1");

describe("la misma ficha en MAULLIN trae la resolución de CERTIFICACIÓN (capturada el 2026-10-14, RUT 11598736-4)", () => {
  const r = interpretarPadron(fixture("emisor-certificacion-maullin.html"));

  it("NroResol 0 y la fecha con que el RUT entró a certificar: lo que la carátula de un envío en maullin exige", () => {
    expect(r.clase).toBe("emisor");
    if (r.clase !== "emisor") return;
    expect(r.rut).toBe("11598736-4");
    expect(r.numeroResolucion).toBe("0");
    expect(r.fechaResolucion).toBe("05-12-2016");
    // En maullin todo RUT inscrito aparece habilitado para todos los tipos: no sirve de padrón de tipos.
    expect(r.documentos.map((d) => d.codigo)).toContain(46);
  });
});

describe("emisor autorizado", () => {
  const r = interpretarPadron(fixture("emisor-autorizado.html"));

  it("lo reconoce como emisor y lee sus antecedentes", () => {
    expect(r.clase).toBe("emisor");
    if (r.clase !== "emisor") return;
    expect(r.rut).toBe("76086428-5");
    expect(r.razonSocial).toBe("MGM AUDITORES CONSULTORES SPA");
    expect(r.numeroResolucion).toBe("86");
    expect(r.fechaResolucion).toBe("01-09-2005");
    expect(r.direccionRegional).toBe("V");
  });

  it("lee QUÉ documentos puede emitir, que es el dato que el padrón agrega", () => {
    if (r.clase !== "emisor") throw new Error("no es emisor");
    const codigos = r.documentos.map((d) => d.codigo);
    expect(codigos).toContain(33);
    expect(codigos).toContain(34);
    expect(codigos).toContain(61);
    const f33 = r.documentos.find((d) => d.codigo === 33);
    expect(f33?.descripcion).toContain("FACTURA");
    expect(f33?.autorizadoDesde).toBe("07-01-2023");
    expect(f33?.desautorizadoDesde).toBeNull();
  });

  it("un emisor es SIEMPRE receptor electrónico (Res. Ex. 45/2003, resolutivo Quinto)", () => {
    expect(formaDeEntrega(r)).toBe("electronica");
  });
});

describe("autorizado solo como receptor", () => {
  const r = interpretarPadron(fixture("solo-receptor.html"));

  it("lo distingue de un emisor", () => {
    expect(r.clase).toBe("solo_receptor");
    if (r.clase !== "solo_receptor") return;
    expect(r.rut).toBe("61999390-K");
    expect(r.razonSocial).toBe("SUBSECRETARIA DE SEGURIDAD PUBLICA");
    // No emite nada: la lista vacía es el dato, no una falla de parseo.
    expect(r.documentos).toEqual([]);
  });

  it("igual recibe por medios electrónicos", () => {
    expect(formaDeEntrega(r)).toBe("electronica");
  });
});

describe("no figura en el padrón", () => {
  const r = interpretarPadron(fixture("ausente.html"));

  it("se reconoce, y NO se confunde con un error", () => {
    expect(r.clase).toBe("ausente");
  });

  it("se le entrega representación IMPRESA — que no es lo mismo que no facturarle", () => {
    // Resolutivo Cuarto n°5: al receptor no electrónico se le entrega la representación impresa.
    // Usar esto como compuerta para negar una venta es usarlo mal.
    expect(formaDeEntrega(r)).toBe("impresa");
  });
});

describe("falla CERRADO", () => {
  it("una página desconocida es ilegible, nunca 'ausente'", () => {
    const r = interpretarPadron("<html><body>Servicio no disponible</body></html>");
    expect(r.clase).toBe("ilegible");
    expect(formaDeEntrega(r)).toBe("desconocida");
  });

  it("una respuesta vacía es ilegible", () => {
    expect(interpretarPadron("").clase).toBe("ilegible");
  });

  it("antecedentes SIN el veredicto de emisión es ilegible, no emisor vacío", () => {
    // Es el caso que importa: si el SII cambia el texto del veredicto pero mantiene la tabla de
    // antecedentes, un parser optimista devolvería "emisor sin documentos" — un dato falso.
    const mutilado = fixture("emisor-autorizado.html").replace(
      /tiene autorizada la emisi[^<]*/i,
      "texto nuevo que no reconocemos",
    );
    const r = interpretarPadron(mutilado);
    expect(r.clase).toBe("ilegible");
  });

  it("antecedentes sin RUT ni razón social es ilegible", () => {
    const mutilado = fixture("solo-receptor.html")
      .replace(/76086428-5|61999390-K/g, "")
      .replace(/SUBSECRETARIA DE SEGURIDAD PUBLICA/g, "");
    expect(interpretarPadron(mutilado).clase).toBe("ilegible");
  });

  it("un HTML que dice que emite pero sin tabla de tipos es ilegible", () => {
    const sinTabla = fixture("emisor-autorizado.html").replace(
      /<tr>[\s\S]*?<\/tr>/gi,
      (fila) => (/\b(33|34|52|56|61)\b/.test(fila) ? "" : fila),
    );
    expect(interpretarPadron(sinTabla).clase).toBe("ilegible");
  });
});
