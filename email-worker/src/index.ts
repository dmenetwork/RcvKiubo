/**
 * Email Worker de la casilla de intercambio DTE. Copia del de Kiubo (`belen-abos/deploy/email-worker`):
 * el contrato es el mismo, así que este Worker sirve para RcvKiubo o para Kiubo cambiando `INTERCAMBIO_URL`.
 *
 * Por cada correo:
 *   1. Lo reenvía a cada destino de FORWARD_TO: una copia legible fuera del servicio.
 *      Un destino que falla (p. ej. sin verificar en Cloudflare) se loguea y NO frena a los demás ni
 *      al paso 2.
 *   2. Hace POST del crudo al servicio (INTERCAMBIO_URL, header x-intercambio-secret).
 *      · 2xx → listo.
 *      · 400 (cuerpo vacío) / 413 (demasiado grande) → log; reintentar no lo arregla.
 *      · TODO lo demás se reintenta: red, timeout, 3xx, 5xx, y también 401/403/404, que son errores
 *        de configuración que un operador arregla (clave rotada en un solo lado, Worker antes que la
 *        API, regla del WAF). El crudo queda en KV (PENDIENTES, 7 días) y el Cron de cada 10 min lo
 *        reintenta. El servicio deduplica por sha256, así que reintentar algo que sí entró no duplica.
 *
 * NO parsea el correo: en Workers Free hay 10 ms de CPU. El MIME se lee en el servicio
 * (src/core/dte-intercambio.ts del servicio). Por lo mismo, la clave de KV es un UUID y no un hash del crudo.
 *
 * Sin dependencias ni tipos de Cloudflare: las interfaces de abajo son el subconjunto que se usa, y
 * así el archivo se testea con el Vitest del servicio (index.test.ts).
 */

export interface Kv {
  put(key: string, value: ArrayBuffer, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  list(opts?: { limit?: number }): Promise<{ keys: Array<{ name: string; metadata?: unknown }> }>;
}

export interface Env {
  PENDIENTES: Kv;
  /** p. ej. https://rcv.ejemplo.cl/v1/intercambio/entrante */
  INTERCAMBIO_URL: string;
  /** Secreto (wrangler secret put): el mismo valor que INTERCAMBIO_SECRET del box. */
  INTERCAMBIO_SECRET: string;
  /** Destinos del reenvío separados por coma. Cada uno verificado en Email Routing. */
  FORWARD_TO: string;
}

export interface CorreoEntrante {
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  forward(destino: string): Promise<unknown>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type Entrega = "ok" | "reintentar" | "rechazado";

const SIETE_DIAS = 7 * 24 * 60 * 60;
const DIEZ_MINUTOS_MS = 10 * 60 * 1000;
/** Workers Free: 50 subpedidos por invocación; cada pendiente cuesta un get + un POST + un delete. */
const PENDIENTES_POR_CICLO = 15;
/** Un box colgado no puede dejar la invocación esperando hasta que Cloudflare la mate. */
const TIMEOUT_POST_MS = 30_000;
/** Lo único que reintentar no arregla. */
const RECHAZO_DEFINITIVO = new Set([400, 413]);

export async function entregar(env: Env, raw: ArrayBuffer, to: string, f: Fetch = fetch): Promise<Entrega> {
  let res: Response;
  try {
    res = await f(env.INTERCAMBIO_URL, {
      method: "POST",
      headers: {
        "content-type": "message/rfc822",
        "x-intercambio-secret": env.INTERCAMBIO_SECRET,
        "x-intercambio-to": to,
      },
      body: raw,
      // Un redirect convertiría el POST en un GET a otra página que quizás responda 200.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_POST_MS),
    });
  } catch (e) {
    console.error(`POST al servicio falló (red o timeout): ${e instanceof Error ? e.message : String(e)}`);
    return "reintentar";
  }
  if (res.status >= 200 && res.status < 300) return "ok";
  if (RECHAZO_DEFINITIVO.has(res.status)) {
    console.error(`POST al servicio rechazado (${res.status}): no se reintenta.`);
    return "rechazado";
  }
  console.error(
    `POST al servicio respondió ${res.status} (server: ${res.headers.get("server") ?? "?"}, cf-ray: ${res.headers.get("cf-ray") ?? "?"}): se reintenta.` +
      (res.status === 401 ? " Revisar que INTERCAMBIO_SECRET sea igual en el box y en el Worker." : ""),
  );
  return "reintentar";
}

export async function procesarCorreo(message: CorreoEntrante, env: Env, f: Fetch = fetch): Promise<Entrega> {
  const raw = await new Response(message.raw).arrayBuffer();

  for (const destino of env.FORWARD_TO.split(",").map((d) => d.trim()).filter(Boolean)) {
    try {
      await message.forward(destino);
    } catch (e) {
      console.error(`reenvío a ${destino} falló: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const r = await entregar(env, raw, message.to, f);
  // Si esto también falla, se deja lanzar: mejor que Cloudflare marque la entrega fallida a que el
  // correo desaparezca en silencio.
  if (r === "reintentar") {
    await env.PENDIENTES.put(crypto.randomUUID(), raw, {
      expirationTtl: SIETE_DIAS,
      metadata: { to: message.to, recibido: Date.now() },
    });
  }
  return r;
}

export interface EstadoCola {
  entregados: number;
  /** Pendientes que quedan en la cola tras este ciclo. */
  pendientes: number;
  /** Cuándo entró el pendiente más antiguo que queda (ms epoch), o `null` si no queda ninguno. */
  masAntiguo: number | null;
}

/**
 * Reintenta hasta PENDIENTES_POR_CICLO pendientes. La ventana ROTA con cada ciclo de 10 min: si
 * siempre se tomaran los primeros, unos pocos que fallan siempre ocuparían todos los cupos y el resto
 * vencería sin reintentarse nunca. Devuelve el estado de la cola, que viaja en el latido.
 */
export async function reintentarPendientes(env: Env, f: Fetch = fetch, ahora = Date.now()): Promise<EstadoCola> {
  // ponytail: una sola página de 1.000 claves; KV Free permite 1.000 escrituras al día, así que la
  // cola no pasa de ahí. Paginar con `cursor` si se pasa a un plan pago.
  const { keys } = await env.PENDIENTES.list({ limit: 1000 });
  const inicio = keys.length === 0 ? 0 : (Math.floor(ahora / DIEZ_MINUTOS_MS) * PENDIENTES_POR_CICLO) % keys.length;
  const ventana = [...keys.slice(inicio), ...keys.slice(0, inicio)].slice(0, PENDIENTES_POR_CICLO);
  const resueltos = new Set<string>();
  let entregados = 0;
  for (const k of ventana) {
    const raw = await env.PENDIENTES.get(k.name, "arrayBuffer");
    if (!raw) {
      resueltos.add(k.name);
      continue;
    }
    const to = (k.metadata as { to?: string } | undefined)?.to ?? "";
    const r = await entregar(env, raw, to, f);
    if (r === "reintentar") continue;
    if (r === "ok") entregados++;
    await env.PENDIENTES.delete(k.name);
    resueltos.add(k.name);
  }
  const quedan = keys.filter((k) => !resueltos.has(k.name));
  const fechas = quedan
    .map((k) => (k.metadata as { recibido?: number } | undefined)?.recibido)
    .filter((t): t is number => typeof t === "number");
  return { entregados, pendientes: quedan.length, masAntiguo: fechas.length ? Math.min(...fechas) : null };
}

/** `…/intercambio/entrante` → `…/intercambio/latido`, tolerando una `/` final o un query. */
export function urlLatido(urlEntrante: string): string {
  const u = new URL(urlEntrante);
  u.pathname = u.pathname.replace(/\/entrante\/?$/, "/latido");
  u.search = "";
  return u.toString();
}

/**
 * Latido al servicio (GET .../latido con la clave y el estado de la cola): prueba Worker → túnel → box →
 * clave, y le cuenta al servicio si hay correos esperando. Con más de 2 h sin latido, o un pendiente de
 * más de 2 h, el servicio lo informa en GET /v1/buzon: sin esto, "no llegaron facturas" se ve igual que "el buzón está caído".
 */
export async function enviarLatido(env: Env, cola: EstadoCola | null = null, f: Fetch = fetch): Promise<boolean> {
  try {
    const res = await f(urlLatido(env.INTERCAMBIO_URL), {
      method: "GET",
      headers: {
        "x-intercambio-secret": env.INTERCAMBIO_SECRET,
        // Sin `cola` (no se pudo leer KV) no se mandan: el servicio conserva lo último que supo.
        ...(cola ? { "x-intercambio-pendientes": String(cola.pendientes) } : {}),
        ...(cola?.masAntiguo != null ? { "x-intercambio-mas-antiguo": String(cola.masAntiguo) } : {}),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 200 && res.status < 300) return true;
    console.error(`latido al servicio respondió ${res.status}`);
  } catch (e) {
    console.error(`latido al servicio falló: ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
}

export default {
  async email(message: CorreoEntrante, env: Env): Promise<void> {
    await procesarCorreo(message, env);
  },
  // Con await (no waitUntil): así corre bajo el límite de 15 min del Cron. Primero los reintentos,
  // después el latido con el estado de la cola que quedó. Subpedidos: 1 list + 15×3 + 1 latido = 47.
  async scheduled(_evento: unknown, env: Env): Promise<void> {
    let cola: EstadoCola | null = null;
    try {
      cola = await reintentarPendientes(env);
    } catch (e) {
      console.error(`reintento de pendientes falló: ${e instanceof Error ? e.message : String(e)}`);
    }
    await enviarLatido(env, cola);
  },
};
