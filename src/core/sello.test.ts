import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { abrir, leerLlavero, sellar, selladoConOtraLlave } from "./sello";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");

describe("sello AES-256-GCM", () => {
  it("sella y abre con el mismo AAD", () => {
    const ll = leerLlavero(`1:${k1}`);
    const s = sellar("-----BEGIN PRIVATE KEY-----", "contribuyente-1", ll);
    expect(abrir(s, "contribuyente-1", ll).toString()).toBe("-----BEGIN PRIVATE KEY-----");
  });

  it("no abre con el AAD de otra fila ni con un byte alterado", () => {
    const ll = leerLlavero(`1:${k1}`);
    const s = sellar("secreto", "a", ll);
    expect(() => abrir(s, "b", ll)).toThrow(/no abre/);
    const alterado = Buffer.from(s);
    alterado[alterado.length - 1]! ^= 1;
    expect(() => abrir(alterado, "a", ll)).toThrow(/no abre/);
  });

  it("rota: sella con la primera, abre lo sellado con una anterior", () => {
    const viejo = leerLlavero(`1:${k1}`);
    const s = sellar("x", "a", viejo);
    const nuevo = leerLlavero(`2:${k2},1:${k1}`);
    expect(abrir(s, "a", nuevo).toString()).toBe("x");
    expect(selladoConOtraLlave(s, nuevo)).toBe(true);
    expect(selladoConOtraLlave(sellar("x", "a", nuevo), nuevo)).toBe(false);
    expect(() => abrir(s, "a", leerLlavero(`2:${k2}`))).toThrow(/llave 1/);
  });

  it("valida el llavero", () => {
    expect(() => leerLlavero("")).toThrow(/vacío/);
    expect(() => leerLlavero("1:abcd")).toThrow(/32 bytes/);
    expect(() => leerLlavero(`1:${k1},1:${k2}`)).toThrow(/repetida/);
  });
});
