import { describe, expect, it } from "vitest";
import { esIpProhibida, esNombreLocal, hostNormalizado, lookupSeguro } from "./red";

describe("direcciones prohibidas para webhooks (SSRF)", () => {
  it("bloquea privadas, loopback, link-local, CGNAT y lo no especificado", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.93.206.15", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1"]) {
      expect(esIpProhibida(ip), ip).toBe(true);
    }
  });

  it("bloquea IPv4 mapeadas en IPv6, como las normaliza el parser de URL", () => {
    expect(esIpProhibida("::ffff:127.0.0.1")).toBe(true);
    expect(hostNormalizado(new URL("https://[::ffff:127.0.0.1]/"))).toBe("::ffff:7f00:1");
    expect(esIpProhibida("::ffff:7f00:1")).toBe(true);
  });

  it("deja pasar direcciones públicas", () => {
    expect(esIpProhibida("1.1.1.1")).toBe(false);
    expect(esIpProhibida("2606:4700:4700::1111")).toBe(false);
  });

  it("el punto final y los nombres locales no engañan", () => {
    expect(hostNormalizado(new URL("https://localhost./x"))).toBe("localhost");
    expect(esNombreLocal("localhost")).toBe(true);
    expect(esNombreLocal("router.lan")).toBe(true);
    expect(esNombreLocal("intranet")).toBe(true);
    expect(esNombreLocal("hooks.kiubo.io")).toBe(false);
  });

  it("al CONECTAR rechaza un nombre que resuelve a una IP prohibida", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => lookupSeguro("localhost", { all: true }, (e) => r(e)));
    expect(err?.code).toBe("EWEBHOOKPROHIBIDO");
  });
});
