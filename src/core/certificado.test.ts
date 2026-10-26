import { describe, expect, it } from "vitest";
import { CertificadoInvalidoError, firmanteDesde, leerPfx } from "./certificado";
import { construirGetToken } from "./dte-token";
import { pfxDePrueba } from "../test/pfx";

describe("leerPfx", () => {
  it("abre un .pfx 3DES, saca el RUT del subject (no el de la CA) y deja un firmante usable", () => {
    const c = leerPfx(pfxDePrueba({ clave: "secreto", rutEn: "subject" }), "secreto");
    expect(c.rutTitular).toBe("11598736-4");
    expect(c.nombreTitular).toBe("JUAN PEREZ SOTO");
    expect(c.emisor).toBe("E-CERTCHILE CA FIRMA ELECTRONICA");
    expect(c.validoHasta.toISOString()).toBe("2028-01-01T00:00:00.000Z");
    expect(c.huella).toMatch(/^[0-9a-f]{64}$/);
    // El firmante sirve para lo que existe: firmar la semilla del SII.
    expect(construirGetToken("012345", c.firmante)).toContain("<SignatureValue>");
  });

  it("lee el RUT desde el otherName del SAN (formato e-CertChile)", () => {
    expect(leerPfx(pfxDePrueba({ clave: "x", rutEn: "san", algoritmo: "aes256" }), "x").rutTitular).toBe("11598736-4");
  });

  it("sin RUT en el certificado devuelve null en vez de adivinar", () => {
    expect(leerPfx(pfxDePrueba({ clave: "x", rutEn: "ninguno" }), "x").rutTitular).toBeNull();
  });

  it("una clave equivocada es PFX_ILEGIBLE", () => {
    try {
      leerPfx(pfxDePrueba({ clave: "buena", rutEn: "subject" }), "mala");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CertificadoInvalidoError);
      expect((e as CertificadoInvalidoError).codigo).toBe("PFX_ILEGIBLE");
    }
  });

  it("firmanteDesde reconstruye el mismo firmante desde lo guardado", () => {
    const c = leerPfx(pfxDePrueba({ clave: "x", rutEn: "subject" }), "x");
    expect(firmanteDesde(c.firmante.llavePrivadaPem, c.firmante.x509)).toEqual(c.firmante);
  });
});
