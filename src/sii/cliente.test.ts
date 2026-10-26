import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CertificadoFirmante } from "../core/dte-firma";
import { ClienteSii, ErrorSii, type ContextoSii } from "./cliente";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
const jwk = createPublicKey(pem).export({ format: "jwk" }) as { n: string; e: string };
const CERT: CertificadoFirmante = { llavePrivadaPem: pem, modulus: jwk.n, exponent: jwk.e, x509: "QUJD" };

const SEMILLA = `<x>&lt;SII:RESP_BODY&gt;&lt;SEMILLA&gt;012345678&lt;/SEMILLA&gt;&lt;/SII:RESP_BODY&gt;</x>`;
const token = (t: string) => `<x>&lt;TOKEN&gt;${t}&lt;/TOKEN&gt;</x>`;
const respuestaTo = (cuerpo: string) =>
  `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:r xmlns:ns2="http://ws.registroreclamodte.diii.sdi.sii.cl"><return>${cuerpo}</return></ns2:r></S:Body></S:Envelope>`;
const estado = (e: string) => `<getEstDteReturn>&lt;SII:RESP_HDR&gt;&lt;ESTADO&gt;${e}&lt;/ESTADO&gt;&lt;/SII:RESP_HDR&gt;</getEstDteReturn>`;

type Respuesta = { status?: number; body: string };

/** Un SII falso: cada llamada se registra y responde según la URL. */
function siiFalso(rutas: Record<string, Respuesta | ((n: number, init: RequestInit) => Respuesta)>) {
  const llamadas: Array<{ url: string; init: RequestInit }> = [];
  const cuenta = new Map<string, number>();
  const f = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    const clave = Object.keys(rutas).find((k) => url.includes(k));
    if (!clave) throw new Error(`ruta no simulada: ${url}`);
    const n = (cuenta.get(clave) ?? 0) + 1;
    cuenta.set(clave, n);
    const r = rutas[clave]!;
    const { status = 200, body } = typeof r === "function" ? r(n, init) : r;
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { f, llamadas, cuenta };
}

const ctx: ContextoSii = { clave: "c1", ambiente: "produccion", certificado: async () => CERT };
const DOC = { rutEmisor: "76086428-5", tipoDoc: 33, folio: 10 };
const sinEspera = { dormir: async () => {}, esperaBaseMs: 1 };

describe("token", () => {
  it("canjea la semilla firmada y cachea el token (una sola semilla para dos llamadas)", async () => {
    const s = siiFalso({
      "CrSeed.jws": { body: SEMILLA },
      "GetTokenFromSeed.jws": { body: token("TOK1") },
      registroreclamodteservice: { body: respuestaTo("<codResp>0</codResp><descResp>OK</descResp>") },
    });
    const c = new ClienteSii({ fetch: s.f, ...sinEspera });
    await Promise.all([c.registrarAccion(ctx, DOC, "ACD"), c.registrarAccion(ctx, DOC, "ERM")]);
    expect(s.cuenta.get("CrSeed.jws")).toBe(1);
    const canje = s.llamadas.find((l) => l.url.includes("GetTokenFromSeed"))!;
    expect(String(canje.init.body)).toContain("&lt;Semilla&gt;012345678&lt;/Semilla&gt;");
    const reg = s.llamadas.filter((l) => l.url.includes("registroreclamo"));
    expect((reg[0]!.init.headers as Record<string, string>).Cookie).toBe("TOKEN=TOK1");
  });

  it("re-autentica UNA vez ante un 401 y repite con el token nuevo", async () => {
    let tokens = 0;
    const s = siiFalso({
      "CrSeed.jws": { body: SEMILLA },
      "GetTokenFromSeed.jws": () => ({ body: token(`TOK${++tokens}`) }),
      registroreclamodteservice: (n) => (n === 1 ? { status: 401, body: "" } : { body: respuestaTo("<codResp>7</codResp>") }),
    });
    const c = new ClienteSii({ fetch: s.f, ...sinEspera });
    const r = await c.registrarAccion(ctx, DOC, "ACD");
    expect(r.resultado).toBe("ya_estaba");
    const reg = s.llamadas.filter((l) => l.url.includes("registroreclamo"));
    expect((reg[1]!.init.headers as Record<string, string>).Cookie).toBe("TOKEN=TOK2");
  });

  it("si el SII no da token, explica que suele ser el certificado", async () => {
    const s = siiFalso({ "CrSeed.jws": { body: SEMILLA }, "GetTokenFromSeed.jws": { body: "<ESTADO>10</ESTADO>" } });
    await expect(new ClienteSii({ fetch: s.f, ...sinEspera }).token(ctx)).rejects.toMatchObject({ codigo: "SII_SIN_TOKEN" });
  });
});

describe("reintentos", () => {
  it("reintenta un 503 y un error de red, y se rinde tras los reintentos", async () => {
    const s = siiFalso({ "CrSeed.jws": (n) => (n < 3 ? { status: 503, body: "caído" } : { body: SEMILLA }) });
    await expect(new ClienteSii({ fetch: s.f, ...sinEspera }).semilla("produccion")).resolves.toBe("012345678");
    const s2 = siiFalso({ "CrSeed.jws": { status: 502, body: "" } });
    await expect(new ClienteSii({ fetch: s2.f, reintentos: 2, ...sinEspera }).semilla("produccion")).rejects.toMatchObject({
      codigo: "SII_RESPUESTA_INVALIDA",
    });
    expect(s2.cuenta.get("CrSeed.jws")).toBe(3);
  });

  it("codResp −1 (error interno del SII) se reintenta; un rechazo de negocio no", async () => {
    const s = siiFalso({
      "CrSeed.jws": { body: SEMILLA },
      "GetTokenFromSeed.jws": { body: token("T") },
      registroreclamodteservice: (n) => ({ body: respuestaTo(n === 1 ? "<codResp>-1</codResp>" : "<codResp>8</codResp>") }),
    });
    const r = await new ClienteSii({ fetch: s.f, ...sinEspera }).registrarAccion(ctx, DOC, "RCD");
    expect(r).toMatchObject({ codigo: 8, resultado: "rechazado" });
    expect(s.cuenta.get("registroreclamodteservice")).toBe(2);
  });

  it("un SOAP Fault de negocio no se reintenta", async () => {
    const fault = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultstring>Usuario no autorizado</faultstring></S:Fault></S:Body></S:Envelope>`;
    const s = siiFalso({ "CrSeed.jws": { body: SEMILLA }, "GetTokenFromSeed.jws": { body: token("T") }, registroreclamodteservice: { status: 500, body: fault } });
    await expect(new ClienteSii({ fetch: s.f, ...sinEspera }).listarEventos(ctx, DOC)).rejects.toMatchObject({ codigo: "SII_FAULT" });
    expect(s.cuenta.get("registroreclamodteservice")).toBe(1);
  });

  it("no sale a hosts fuera del SII", async () => {
    await expect(new ClienteSii().post("https://evil.com/x", { cuerpo: "", contentType: "text/xml" }, "x")).rejects.toThrow(/fuera del SII/);
  });
});

describe("operaciones", () => {
  const base = { "CrSeed.jws": { body: SEMILLA }, "GetTokenFromSeed.jws": { body: token("T") } };

  it("listarEventos con 16 devuelve lista vacía; cedible clasifica", async () => {
    const s = siiFalso({ ...base, registroreclamodteservice: (_n, init) => ({ body: respuestaTo(String(init.body).includes("listarEventos") ? "<codResp>16</codResp>" : "<codResp>24</codResp>") }) });
    const c = new ClienteSii({ fetch: s.f, ...sinEspera });
    expect(await c.listarEventos(ctx, DOC)).toMatchObject({ codigo: 16, eventos: [] });
    expect(await c.consultarCedible(ctx, DOC)).toMatchObject({ codigo: 24, cedibilidad: "no_cedible" });
  });

  it("estadoDte: un 002 (token inactivo) re-autentica y repite", async () => {
    let tokens = 0;
    const s = siiFalso({
      "CrSeed.jws": { body: SEMILLA },
      "GetTokenFromSeed.jws": () => ({ body: token(`T${++tokens}`) }),
      "QueryEstDte.jws": (n) => ({ body: estado(n === 1 ? "002" : "DOK") }),
    });
    const e = await new ClienteSii({ fetch: s.f, ...sinEspera }).estadoDte(ctx, {
      rutConsultante: "11598736-4", rutEmisor: "76086428-5", rutReceptor: "77840802-3",
      tipoDte: 33, folio: 1, fechaEmision: "2026-10-01", montoTotal: 100,
    });
    expect(e.clase).toBe("valido");
    expect(String(s.llamadas.at(-1)!.init.body)).toContain("<Token>T2</Token>");
  });

  it("limita la concurrencia hacia el SII", async () => {
    let enVuelo = 0;
    let max = 0;
    const f = (async () => {
      enVuelo++;
      max = Math.max(max, enVuelo);
      await new Promise((r) => setTimeout(r, 5));
      enVuelo--;
      return new Response(SEMILLA);
    }) as unknown as typeof fetch;
    const c = new ClienteSii({ fetch: f, concurrencia: 2 });
    await Promise.all(Array.from({ length: 6 }, () => c.semilla("produccion")));
    expect(max).toBe(2);
  });

  it("ErrorSii es distinguible", () => {
    expect(new ErrorSii("SII_FAULT", "x", false)).toBeInstanceOf(Error);
  });
});
