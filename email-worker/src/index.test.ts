import { describe, expect, it, vi } from "vitest";
import {
  enviarLatido,
  urlLatido,
  procesarCorreo,
  reintentarPendientes,
  type CorreoEntrante,
  type Env,
  type Kv,
} from "./index";

// El Email Worker de Cloudflare (email-worker/) es la única copia del correo fuera del box
// mientras el servicio no lo tenga: estos tests fijan que un reenvío fallido no frene nada, que una caída
// del box o un error de configuración dejen el correo en la cola, y que solo 400/413 se descarten.

function kvFalso(): Kv & { datos: Map<string, { value: ArrayBuffer; metadata?: unknown }> } {
  const datos = new Map<string, { value: ArrayBuffer; metadata?: unknown }>();
  return {
    datos,
    async put(key, value, opts) {
      datos.set(key, { value, metadata: opts?.metadata });
    },
    async get(key) {
      return datos.get(key)?.value ?? null;
    },
    async delete(key) {
      datos.delete(key);
    },
    async list() {
      return { keys: [...datos].map(([name, v]) => ({ name, metadata: v.metadata })) };
    },
  };
}

function env(kv = kvFalso()): Env & { PENDIENTES: ReturnType<typeof kvFalso> } {
  return {
    PENDIENTES: kv,
    INTERCAMBIO_URL: "https://rcv.ejemplo.cl/v1/intercambio/entrante",
    INTERCAMBIO_SECRET: "s3cr3t",
    FORWARD_TO: "cliente@gmail.com, diego@gmail.com",
  };
}

function mensaje(forward: (d: string) => Promise<unknown> = async () => undefined, cuerpo = "hola"): CorreoEntrante & { forward: ReturnType<typeof vi.fn> } {
  return {
    to: "belen.chonchi@dte.kiubo.io",
    raw: new Response(`From: x@y.cl\r\n\r\n${cuerpo}`).body!,
    forward: vi.fn(forward),
  };
}

const responde = (status: number) => vi.fn(async () => new Response(null, { status }));

describe("procesarCorreo", () => {
  it("reenvía a cada destino y entrega el crudo con la clave, el destinatario y sin seguir redirects", async () => {
    const e = env();
    const m = mensaje();
    const f = responde(201);
    expect(await procesarCorreo(m, e, f)).toBe("ok");
    expect(m.forward.mock.calls.map((c) => c[0])).toEqual(["cliente@gmail.com", "diego@gmail.com"]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(e.INTERCAMBIO_URL);
    expect(init.headers).toMatchObject({ "x-intercambio-secret": "s3cr3t", "x-intercambio-to": "belen.chonchi@dte.kiubo.io" });
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toContain("hola");
    expect(e.PENDIENTES.datos.size).toBe(0);
  });

  it("un reenvío que falla (destino sin verificar) no frena el otro ni el POST", async () => {
    const m = mensaje(async (d) => {
      if (d === "cliente@gmail.com") throw new Error("destination address not verified");
    });
    const f = responde(201);
    expect(await procesarCorreo(m, env(), f)).toBe("ok");
    expect(m.forward).toHaveBeenCalledTimes(2);
    expect(f).toHaveBeenCalledTimes(1);
  });

  // Solo lo que reintentar no arregla se descarta; un error de configuración (clave rotada en un solo
  // lado, Worker antes que la API, WAF) o un redirect se reintenta durante 7 días.
  it.each([
    [301, "reintentar"],
    [401, "reintentar"],
    [403, "reintentar"],
    [404, "reintentar"],
    [408, "reintentar"],
    [429, "reintentar"],
    [500, "reintentar"],
    [503, "reintentar"],
    [400, "rechazado"],
    [413, "rechazado"],
  ] as const)("status %i → %s", async (status, esperado) => {
    const e = env();
    expect(await procesarCorreo(mensaje(), e, responde(status))).toBe(esperado);
    expect(e.PENDIENTES.datos.size).toBe(esperado === "reintentar" ? 1 : 0);
  });

  it("box caído (red o timeout) → el crudo queda en KV con el destinatario", async () => {
    const e = env();
    const f = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect(await procesarCorreo(mensaje(), e, f)).toBe("reintentar");
    const [entrada] = [...e.PENDIENTES.datos.values()];
    expect(new TextDecoder().decode(entrada!.value)).toContain("hola");
    expect(entrada!.metadata).toMatchObject({ to: "belen.chonchi@dte.kiubo.io", recibido: expect.any(Number) });
  });

  it("si KV también falla, lanza: Cloudflare marca la entrega fallida en vez de perderla en silencio", async () => {
    const kv = kvFalso();
    kv.put = async () => {
      throw new Error("KV caído");
    };
    await expect(procesarCorreo(mensaje(), env(kv), responde(503))).rejects.toThrow("KV caído");
  });
});

describe("reintentarPendientes", () => {
  it("entrega lo pendiente y lo borra; lo que sigue fallando se queda", async () => {
    const e = env();
    await procesarCorreo(mensaje(), e, responde(503));
    expect(await reintentarPendientes(e, responde(502))).toMatchObject({ entregados: 0, pendientes: 1 });
    expect(e.PENDIENTES.datos.size).toBe(1);
    const f = responde(200);
    expect(await reintentarPendientes(e, f)).toEqual({ entregados: 1, pendientes: 0, masAntiguo: null });
    expect(e.PENDIENTES.datos.size).toBe(0);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
      "x-intercambio-to": "belen.chonchi@dte.kiubo.io",
    });
  });

  it("un pendiente que ahora da 413 se borra (no se reintenta para siempre)", async () => {
    const e = env();
    await procesarCorreo(mensaje(), e, responde(503));
    expect(await reintentarPendientes(e, responde(413))).toMatchObject({ entregados: 0, pendientes: 0 });
    expect(e.PENDIENTES.datos.size).toBe(0);
  });

  it("una clave listada que ya venció (get = null) se salta sin POST", async () => {
    const e = env();
    await procesarCorreo(mensaje(), e, responde(503));
    e.PENDIENTES.get = async () => null;
    const f = responde(200);
    expect(await reintentarPendientes(e, f)).toMatchObject({ entregados: 0, pendientes: 0 });
    expect(f).not.toHaveBeenCalled();
  });

  it("la ventana de 15 rota con el ciclo: los que fallan siempre no acaparan los cupos", async () => {
    const e = env();
    for (let i = 0; i < 20; i++) await procesarCorreo(mensaje(undefined, `correo ${i}`), e, responde(503));
    const vistos = new Set<string>();
    const anota = vi.fn(async (_u: string, init: RequestInit) => {
      vistos.add(new TextDecoder().decode(init.body as ArrayBuffer));
      return new Response(null, { status: 503 });
    });
    const CICLO = 10 * 60 * 1000;
    await reintentarPendientes(e, anota, 0);
    await reintentarPendientes(e, anota, CICLO);
    expect(vistos.size).toBe(20);
  });
});

describe("estado de la cola y latido", () => {
  it("reintentarPendientes informa cuántos quedan y desde cuándo espera el más antiguo", async () => {
    const e = env();
    const antes = Date.now();
    await procesarCorreo(mensaje(), e, responde(503));
    await procesarCorreo(mensaje(), e, responde(503));
    const cola = await reintentarPendientes(e, responde(503));
    expect(cola.pendientes).toBe(2);
    expect(cola.masAntiguo).toBeGreaterThanOrEqual(antes);
  });

  it("enviarLatido hace GET a .../latido con la clave y la cola, sin seguir redirects", async () => {
    const e = env();
    const ok = responde(200);
    expect(await enviarLatido(e, { entregados: 0, pendientes: 3, masAntiguo: 1_700_000_000_000 }, ok)).toBe(true);
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rcv.ejemplo.cl/v1/intercambio/latido");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "manual",
      headers: { "x-intercambio-secret": "s3cr3t", "x-intercambio-pendientes": "3", "x-intercambio-mas-antiguo": "1700000000000" },
    });
    expect(await enviarLatido(e, null, responde(401))).toBe(false);
    const sinCola = responde(200);
    await enviarLatido(e, null, sinCola);
    expect((sinCola.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty("x-intercambio-pendientes");
    expect(await enviarLatido(e, null, vi.fn(async () => { throw new Error("red"); }))).toBe(false);
  });

  it("urlLatido tolera una / final o un query en INTERCAMBIO_URL", () => {
    expect(urlLatido("https://x.cl/api/intercambio/entrante/")).toBe("https://x.cl/api/intercambio/latido");
    expect(urlLatido("https://x.cl/api/intercambio/entrante?a=1")).toBe("https://x.cl/api/intercambio/latido");
  });
});
