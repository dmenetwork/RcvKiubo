import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CertificadoFirmante } from "../core/dte-firma";
import { SesionRcv, type FetchPortal } from "./portal";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const jwk = createPublicKey(pem).export({ format: "jwk" }) as { n: string; e: string };
const CERT: CertificadoFirmante = { llavePrivadaPem: pem, modulus: jwk.n, exponent: jwk.e, x509: "QUJD" };

/** Un portal falso: el login siembra TOKEN en la validación; el facade responde lo que se le diga. */
function portalFalso(facade: (metodo: string, cuerpo: { metaData: { conversationId: string }; data: Record<string, unknown> }) => unknown, opts: { sinToken?: boolean } = {}) {
  const llamadas: Array<{ url: string; cookie: string | undefined }> = [];
  const f: FetchPortal = async (url, init) => {
    const cookie = (init.headers as Record<string, string>).Cookie;
    llamadas.push({ url, cookie });
    if (url.includes("IngresoRutClave")) return new Response("inicio", { headers: { "set-cookie": "s_cc=1; Path=/" } });
    if (url.includes("CAutInicio.cgi")) return new Response("", { status: 302, headers: { location: "https://zeusr.sii.cl/AUT2000/InicioAutenticacion/ValidaLoginCertificado.cgi" } });
    if (url.includes("ValidaLoginCertificado")) return new Response("ok", { headers: opts.sinToken ? {} : { "set-cookie": "TOKEN=T0K3N; Path=/" } });
    if (url.endsWith("/consdcvinternetui/")) return new Response("<html></html>");
    const m = /facadeService\/(\w+)$/.exec(url);
    if (m) return new Response(JSON.stringify(facade(m[1]!, JSON.parse(String(init.body)))));
    throw new Error(`no simulado: ${url}`);
  };
  return { f, llamadas };
}

const ok = (data: unknown) => ({ data, respEstado: { codRespuesta: 0 } });

describe("SesionRcv", () => {
  it("entra con el certificado, lleva las cookies y usa el TOKEN como conversationId", async () => {
    const p = portalFalso((metodo, c) => {
      expect(c.metaData.conversationId).toBe("T0K3N");
      return metodo === "getResumen"
        ? ok([{ rsmnTipoDocInteger: 33, dcvNombreTipoDoc: "Factura Electrónica", dcvTipoIngresoDoc: "DET_ELE", rsmnLink: true, rsmnTotDoc: 2, rsmnMntExe: 0, rsmnMntNeto: 100, rsmnMntIVA: 19, rsmnMntIVANoRec: 0, rsmnIVAUsoComun: 0, rsmnMntTotal: 119 }])
        : ok([{ detNroDoc: 1 }, { detNroDoc: 2 }]);
    });
    const s = await SesionRcv.abrir(CERT, "11598736-4", { fetch: p.f });
    expect(await s.resumen("77840802-3", "202610", "COMPRA", "REGISTRO")).toEqual([
      expect.objectContaining({ tipoDte: 33, totalDocumentos: 2, montoTotal: 119, tieneDetalle: true }),
    ]);
    expect(await s.detalle("77840802-3", "202610", "COMPRA", "REGISTRO", 33)).toHaveLength(2);
    const facade = p.llamadas.find((l) => l.url.includes("facadeService"))!;
    expect(facade.cookie).toContain("TOKEN=T0K3N");
    expect(facade.cookie).toContain("s_cc=1");
  });

  it("sin TOKEN tras el login explica que es el certificado", async () => {
    const p = portalFalso(() => ok([]), { sinToken: true });
    await expect(SesionRcv.abrir(CERT, "11598736-4", { fetch: p.f })).rejects.toMatchObject({ codigo: "SII_SIN_TOKEN" });
  });

  it("si el SII pide captcha se DETIENE (no reintenta ni manda nada de captcha)", async () => {
    let pedidos = 0;
    const p = portalFalso(() => {
      pedidos++;
      return { respEstado: { codRespuesta: 1, msgeRespuesta: "Debe validar reCAPTCHA" } };
    });
    const s = await SesionRcv.abrir(CERT, "11598736-4", { fetch: p.f, dormir: async () => {} });
    await expect(s.resumen("11598736-4", "202610", "COMPRA", "REGISTRO")).rejects.toMatchObject({ codigo: "SII_CAPTCHA" });
    expect(pedidos).toBe(1);
  });

  it("no sigue una redirección fuera del SII", async () => {
    const f: FetchPortal = async () => new Response("", { status: 302, headers: { location: "https://evil.example.com/" } });
    await expect(SesionRcv.abrir(CERT, "11598736-4", { fetch: f })).rejects.toThrow(/fuera del SII/);
  });
});
