import { describe, expect, it } from "vitest";
import { firmarWebhook, generarApiKey, hashApiKey, pareceApiKey, secretoIgual, verificarWebhook } from "./credenciales";

describe("API keys", () => {
  it("se guarda el hash, no la clave", () => {
    const k = generarApiKey();
    expect(pareceApiKey(k.clave)).toBe(true);
    expect(k.hash).toBe(hashApiKey(k.clave));
    expect(k.hash).not.toContain(k.clave);
    expect(k.clave.startsWith(k.prefijo)).toBe(true);
  });
});

describe("firma de webhooks", () => {
  const ahora = new Date("2026-10-26T12:00:00Z");

  it("verifica lo que firma", () => {
    const f = firmarWebhook("whsec_x", '{"a":1}', ahora);
    expect(verificarWebhook(f, "whsec_x", '{"a":1}', ahora)).toBe(true);
  });

  it("rechaza otro cuerpo, otro secreto y una firma vieja (reenvío)", () => {
    const f = firmarWebhook("whsec_x", '{"a":1}', ahora);
    expect(verificarWebhook(f, "whsec_x", '{"a":2}', ahora)).toBe(false);
    expect(verificarWebhook(f, "whsec_y", '{"a":1}', ahora)).toBe(false);
    expect(verificarWebhook(f, "whsec_x", '{"a":1}', new Date(ahora.getTime() + 301_000))).toBe(false);
    expect(verificarWebhook("basura", "whsec_x", "", ahora)).toBe(false);
  });

  it("secretoIgual compara en tiempo constante sin depender del largo", () => {
    expect(secretoIgual("abc", "abc")).toBe(true);
    expect(secretoIgual("abc", "abcd")).toBe(false);
  });
});
