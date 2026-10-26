import { describe, expect, it } from "vitest";
import { bloqueDe, contenidoDe, elementos } from "./xml-lineal";

// xml-lineal reemplaza regex perezosos que corren sobre XML de desconocidos (buzón de intercambio).
// Dos contratos: da EXACTAMENTE lo que daba el regex (la emisión de boletas también lo usa vía
// dte-ted), y es lineal: un correo armado no puede congelar el proceso del POS.

const regexContenido = (xml: string, tag: string) =>
  new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;
const regexContenidoEstricto = (xml: string, tag: string) =>
  new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? null;
const regexTodos = (xml: string, tag: string) =>
  [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"))].map((m) => m[0]);

const CASOS = [
  "<DTE>a</DTE>",
  '<DTE version="1.0"><Folio>7</Folio></DTE>',
  "<DTEx>no</DTEx><DTE>si</DTE>",
  "<DTE><DTE>anidado</DTE></DTE>",
  "<DTE>sin cierre",
  "<DTE sin mayor que",
  "</DTE><DTE>despues del cierre",
  "<DTE/><DTE>x</DTE>",
  "<DTE>uno</DTE> medio <DTE a='b'>dos</DTE>",
  "<DTE-x>guion</DTE-x><DTE>z</DTE>",
  "",
  "<DTE",
  "texto <DTE>\n multi\nlínea </DTE> fin",
];

describe("equivalencia con el regex que reemplaza", () => {
  it.each(CASOS)("contenidoDe palabra = /<tag\\b[^>]*>…/ en %j", (xml) => {
    expect(contenidoDe(xml, "DTE")).toBe(regexContenido(xml, "DTE"));
  });

  it.each(CASOS)("contenidoDe estricta = /<tag(?:\\s[^>]*)?>…/ en %j", (xml) => {
    expect(contenidoDe(xml, "DTE", "estricta")).toBe(regexContenidoEstricto(xml, "DTE"));
  });

  it.each(CASOS)("elementos = matchAll /g en %j", (xml) => {
    expect(elementos(xml, "DTE").map((e) => xml.slice(e.inicio, e.fin))).toEqual(regexTodos(xml, "DTE"));
  });

  it("exacta solo acepta <tag> sin atributos", () => {
    expect(contenidoDe('<DD a="1">x</DD><DD>y</DD>', "DD", "exacta")).toBe("y");
    expect(bloqueDe("<DD>y</DD>", "DD", "exacta")).toBe("<DD>y</DD>");
  });
});

describe("tiempo lineal sobre entrada hostil", () => {
  it.each([
    ["aperturas sin cierre", "<DTE>".repeat(40_000)],
    ["aperturas sin >", "<DTE ".repeat(40_000)],
    ["cierres antes que aperturas", "</DTE>".repeat(1000) + "<DTE>".repeat(40_000)],
  ])("%s (~200 KB: el regex de antes tardaba ~2 s; una regresión falla sin colgar la suite) en menos de 200 ms", (_caso, xml) => {
    const t = performance.now();
    contenidoDe(xml, "DTE");
    elementos(xml, "DTE");
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("elementos con max", () => {
  it("para de buscar al llegar al tope", () => {
    expect(elementos("<A>1</A><A>2</A><A>3</A>", "A", "palabra", 2)).toHaveLength(2);
    expect(elementos("<A>1</A>", "A", "palabra", 0)).toHaveLength(0);
  });
});
