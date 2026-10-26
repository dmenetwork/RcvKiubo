import { limpiarBase, SII_PRUEBA } from "../test/entorno";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUT_KIUBO, RUT_PROVEEDOR, cafDePrueba, certificadoDePrueba, dteDePrueba } from "../core/__fixtures__/material";
import { serializarSobre } from "../core/__fixtures__/dte-sobre";
import { ClienteSii } from "../sii/cliente";
import { pfxDePrueba } from "../test/pfx";
import { siiFalso } from "../test/sii-falso";
import { usarClienteSii } from "../workers/sii";
import { crearApp } from "./app";

const ADMIN = process.env.ADMIN_TOKEN!;
const CERT = certificadoDePrueba();
const CAF = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: SII_PRUEBA.privada });
const sobre = (folio: number) =>
  serializarSobre(
    [{ tipoDte: 33, xml: dteDePrueba({ folio }, CAF, CERT) }],
    { rutEmisor: RUT_PROVEEDOR, rutEnvia: "11598736-4", rutReceptor: RUT_KIUBO, fechaResolucion: "2014-08-22", numeroResolucion: "80" },
    CERT,
    new Date("2026-10-01T13:00:00Z"),
    "dte",
  );

let servidor: Server;
let base: string;

beforeAll(async () => {
  servidor = crearApp().listen(0);
  await new Promise((r) => servidor.once("listening", r));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
afterAll(() => servidor.close());

beforeEach(async () => {
  await limpiarBase();
  usarClienteSii(new ClienteSii({ fetch: siiFalso().fetch, dormir: async () => {} }));
});

async function llamar(metodo: string, ruta: string, opts: { token?: string; json?: unknown; cuerpo?: RequestInit["body"]; tipo?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + ruta, {
    method: metodo,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.json !== undefined ? { "Content-Type": "application/json" } : opts.tipo ? { "Content-Type": opts.tipo } : {}),
      ...opts.headers,
    },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.cuerpo,
  });
  const texto = await res.text();
  let cuerpo: unknown = texto;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    /* no es JSON */
  }
  return { status: res.status, cuerpo: cuerpo as any, headers: res.headers };
}

/** Consumidor + contribuyente con certificado, listo para operar. */
async function preparar() {
  const cons = await llamar("POST", "/admin/consumidores", { token: ADMIN, json: { nombre: "Kiubo" } });
  const key = cons.cuerpo.apiKey as string;
  const c = await llamar("POST", "/v1/contribuyentes", { token: key, json: { rut: "77.840.802-3", ambiente: "certificacion" } });
  // La casilla la asigna el operador, no el consumidor.
  const casilla = await llamar("PUT", `/admin/contribuyentes/${c.cuerpo.id}/casilla`, { token: ADMIN, json: { correo: "Belen@dte.kiubo.io" } });
  expect(casilla.cuerpo.correoIntercambio).toBe("belen@dte.kiubo.io");
  const cert = await llamar("PUT", `/v1/contribuyentes/${c.cuerpo.id}/certificado`, {
    token: key,
    json: { pfxBase64: pfxDePrueba({ clave: "x" }).toString("base64"), clave: "x" },
  });
  expect(cert.status).toBe(200);
  return { key, id: c.cuerpo.id as string };
}

describe("sistema", () => {
  it("health, openapi y 404 con la forma de error", async () => {
    expect((await llamar("GET", "/health")).cuerpo).toEqual({ ok: true, db: true });
    const o = await llamar("GET", "/openapi.json");
    expect(o.cuerpo.openapi).toBe("3.1.0");
    expect(Object.keys(o.cuerpo.paths).length).toBeGreaterThan(30);
    expect((await llamar("GET", "/nada")).cuerpo).toEqual({ error: { codigo: "NO_ENCONTRADO", mensaje: "Ruta inexistente." } });
  });
});

describe("autenticación", () => {
  it("admin exige su token; v1 exige una API key viva", async () => {
    expect((await llamar("POST", "/admin/consumidores", { json: { nombre: "x" } })).status).toBe(401);
    expect((await llamar("POST", "/admin/consumidores", { token: "otro", json: { nombre: "x" } })).status).toBe(401);
    expect((await llamar("GET", "/v1/yo", { token: "rk_inventada_0000000000000000000000000000000" })).status).toBe(401);

    const cons = await llamar("POST", "/admin/consumidores", { token: ADMIN, json: { nombre: "Kiubo" } });
    expect(cons.status).toBe(201);
    expect((await llamar("GET", "/v1/yo", { token: cons.cuerpo.apiKey })).cuerpo.nombre).toBe("Kiubo");

    const lista = await llamar("GET", "/admin/consumidores", { token: ADMIN });
    const keyId = lista.cuerpo.consumidores[0].apiKeys[0].id;
    expect((await llamar("DELETE", `/admin/api-keys/${keyId}`, { token: ADMIN })).status).toBe(204);
    expect((await llamar("GET", "/v1/yo", { token: cons.cuerpo.apiKey })).status).toBe(401);
  });

  it("el consumidor NO puede fijarse una casilla de intercambio (la asigna el operador)", async () => {
    const { key, id } = await preparar();
    await llamar("PATCH", `/v1/contribuyentes/${id}`, { token: key, json: { correoIntercambio: "robada@dte.kiubo.io" } });
    expect((await llamar("GET", `/v1/contribuyentes/${id}`, { token: key })).cuerpo.correoIntercambio).toBe("belen@dte.kiubo.io");
    const otro = await llamar("POST", "/admin/consumidores", { token: ADMIN, json: { nombre: "otro" } });
    const c2 = await llamar("POST", "/v1/contribuyentes", { token: otro.cuerpo.apiKey, json: { rut: "77840802-3", ambiente: "certificacion", correoIntercambio: "belen@dte.kiubo.io" } });
    expect(c2.status).toBe(201);
    expect(c2.cuerpo.correoIntercambio).toBeNull();
    const dup = await llamar("PUT", `/admin/contribuyentes/${c2.cuerpo.id}/casilla`, { token: ADMIN, json: { correo: "belen@dte.kiubo.io" } });
    expect(dup.cuerpo.error.codigo).toBe("CASILLA_DUPLICADA");
  });

  it("un consumidor no ve los contribuyentes de otro", async () => {
    const { id } = await preparar();
    const otro = await llamar("POST", "/admin/consumidores", { token: ADMIN, json: { nombre: "otro" } });
    expect((await llamar("GET", `/v1/contribuyentes/${id}`, { token: otro.cuerpo.apiKey })).status).toBe(404);
    expect((await llamar("GET", "/v1/contribuyentes", { token: otro.cuerpo.apiKey })).cuerpo.contribuyentes).toEqual([]);
  });
});

describe("contribuyentes y certificado", () => {
  it("valida el RUT con su dígito y normaliza", async () => {
    const cons = await llamar("POST", "/admin/consumidores", { token: ADMIN, json: { nombre: "K" } });
    const malo = await llamar("POST", "/v1/contribuyentes", { token: cons.cuerpo.apiKey, json: { rut: "77840802-4", ambiente: "produccion" } });
    expect(malo.status).toBe(400);
    expect(malo.cuerpo.error.codigo).toBe("VALIDACION");
    const { key, id } = await preparar();
    const c = await llamar("GET", `/v1/contribuyentes/${id}`, { token: key });
    expect(c.cuerpo).toMatchObject({ rut: "77840802-3", correoIntercambio: "belen@dte.kiubo.io", certificado: { rutTitular: "11598736-4" } });
    expect(JSON.stringify(c.cuerpo)).not.toMatch(/PRIVATE|llave/i);
  });

  it("un pfx con clave mala es 400 PFX_ILEGIBLE; probar pide un token al SII", async () => {
    const { key, id } = await preparar();
    const mal = await llamar("PUT", `/v1/contribuyentes/${id}/certificado`, { token: key, json: { pfxBase64: pfxDePrueba({ clave: "a" }).toString("base64"), clave: "b" } });
    expect(mal.cuerpo.error.codigo).toBe("PFX_ILEGIBLE");
    expect((await llamar("POST", `/v1/contribuyentes/${id}/certificado/probar`, { token: key })).cuerpo.ok).toBe(true);
  });
});

describe("documentos", () => {
  it("sube XML crudo, lista, descarga el original, acepta ante el SII y genera la respuesta firmada", async () => {
    const { key, id } = await preparar();
    const subida = await llamar("POST", `/v1/contribuyentes/${id}/recibidos`, { token: key, cuerpo: new Uint8Array(sobre(11)), tipo: "application/xml" });
    expect(subida.status).toBe(201);
    expect(subida.cuerpo.documentos[0]).toMatchObject({ folio: 11, resultado: "nuevo", verificacion: { ok: true } });
    const docId = subida.cuerpo.documentos[0].id;

    const lista = await llamar("GET", `/v1/contribuyentes/${id}/documentos?pendientes=true`, { token: key });
    expect(lista.cuerpo.documentos).toHaveLength(1);
    expect(lista.cuerpo.documentos[0].plazo.estado).toBe("sin_fecha");

    const xml = await llamar("GET", `/v1/contribuyentes/${id}/documentos/${docId}/xml`, { token: key });
    expect(xml.headers.get("content-type")).toContain("ISO-8859-1");
    expect(String(xml.cuerpo)).toContain("<DTE");

    const acc = await llamar("POST", `/v1/contribuyentes/${id}/documentos/${docId}/accion`, { token: key, json: { accion: "ACD" } });
    expect(acc.cuerpo).toMatchObject({ codigo: 0, resultado: "registrado", documento: { sii: { eventoReceptor: "ACD" } } });
    expect((await llamar("POST", `/v1/contribuyentes/${id}/documentos/${docId}/accion`, { token: key, json: { accion: "XYZ" } })).status).toBe(400);

    const resp = await llamar("POST", `/v1/contribuyentes/${id}/documentos/${docId}/respuesta`, { token: key, json: { tipo: "recibo", recinto: "BODEGA CASTRO" } });
    expect(resp.status).toBe(200);
    expect(String(resp.cuerpo)).toContain("<EnvioRecibos");
    expect(resp.headers.get("content-disposition")).toContain("EnvioRecibos_");
  });

  it("las consultas directas al SII validan el tipo antes de salir a la red", async () => {
    const { key, id } = await preparar();
    const r = await llamar("POST", `/v1/contribuyentes/${id}/sii/fecha-recepcion`, { token: key, json: { rutEmisor: RUT_PROVEEDOR, tipoDte: 33, folio: 5 } });
    expect(r.cuerpo).toEqual({ fechaRecepcion: "2026-10-01T10:00:00-03:00", plazoVence: "2026-10-09T13:00:00.000Z" });
    const nc = await llamar("POST", `/v1/contribuyentes/${id}/sii/eventos`, { token: key, json: { rutEmisor: RUT_PROVEEDOR, tipoDte: 61, folio: 5 } });
    expect(nc.cuerpo.error.codigo).toBe("TIPO_SIN_REGISTRO");
    const est = await llamar("POST", `/v1/contribuyentes/${id}/sii/estado-dte`, {
      token: key,
      json: { rutEmisor: RUT_PROVEEDOR, rutReceptor: RUT_KIUBO, tipoDte: 33, folio: 5, fechaEmision: "2026-10-01", montoTotal: 11900 },
    });
    expect(est.cuerpo).toMatchObject({ estado: "DOK", clase: "valido" });
  });
});

describe("RCV por HTTP", () => {
  it("importa un CSV crudo con el período en la query, y cruza", async () => {
    const { key, id } = await preparar();
    const csv = `Tipo Doc;RUT Proveedor;Razon Social;Folio;Fecha Docto;Fecha Recepcion;Monto Total\n33;${RUT_PROVEEDOR};P;7;01/10/2026;01/10/2026 10:00:00;11900\n`;
    const r = await llamar("POST", `/v1/contribuyentes/${id}/rcv/importar?periodo=202610`, { token: key, cuerpo: csv, tipo: "text/csv" });
    expect(r.status).toBe(201);
    expect(r.cuerpo.importacion).toMatchObject({ operacion: "COMPRA", nuevos: 1 });
    const c = await llamar("GET", `/v1/contribuyentes/${id}/rcv/cruce?periodo=202610`, { token: key });
    expect(c.cuerpo.totales.faltaXml).toBe(1);
    const sinPeriodo = await llamar("POST", `/v1/contribuyentes/${id}/rcv/importar`, { token: key, json: { csvBase64: Buffer.from(csv + " ").toString("base64") } });
    expect(sinPeriodo.cuerpo.error.codigo).toBe("RCV_SIN_PERIODO");
  });
});

describe("Email Worker", () => {
  it("exige el secreto, ingresa el correo y registra el latido", async () => {
    const { key } = await preparar();
    const b = "L";
    const correo =
      `From: dte@proveedor.cl\r\nSubject: DTE\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n` +
      `--${b}\r\nContent-Type: text/xml; name="e.xml"\r\nContent-Disposition: attachment; filename="e.xml"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
      `${sobre(31).toString("base64")}\r\n--${b}--\r\n`;
    expect((await llamar("POST", "/v1/intercambio/entrante", { cuerpo: correo, tipo: "message/rfc822" })).status).toBe(401);
    const r = await llamar("POST", "/v1/intercambio/entrante", {
      cuerpo: correo,
      tipo: "message/rfc822",
      headers: { "x-intercambio-secret": process.env.INTERCAMBIO_SECRET!, "x-intercambio-to": "belen@dte.kiubo.io" },
    });
    expect(r.cuerpo).toMatchObject({ estado: "dte", duplicado: false });
    expect((await llamar("GET", "/v1/intercambio/latido", { headers: { "x-intercambio-secret": process.env.INTERCAMBIO_SECRET!, "x-intercambio-pendientes": "0" } })).status).toBe(200);
    expect((await llamar("GET", "/v1/buzon", { token: key })).cuerpo.sano).toBe(true);
  });
});
