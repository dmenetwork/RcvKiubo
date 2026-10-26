import type { CertificadoFirmante } from "../core/dte-firma";
import { construirGetToken, extraerSemilla, extraerToken } from "../core/dte-token";
import {
  BASE_DTEWS,
  parsearEstadoDte,
  sobreEstadoDte,
  type ConsultaEstadoDte,
  type EstadoDte,
} from "../core/estado-dte";
import { interpretarPadron, type ResultadoPadron } from "../core/padron-sii";
import {
  URL_REGISTRO_RECLAMO,
  clasificarAccion,
  clasificarCedible,
  faultDe,
  parsearEventos,
  parsearFechaRecepcion,
  parsearRespuesta,
  sobreConsultarCedible,
  sobreFechaRecepcion,
  sobreIngresarAccion,
  sobreListarEventos,
  type AccionReclamo,
  type AmbienteSii,
  type Cedibilidad,
  type DocumentoSii,
  type EventoSii,
  type ResultadoAccion,
} from "../core/registro-reclamo";

/**
 * Cliente de los servicios OFICIALES del SII que usa este servicio. Todo lo que sale a la red pasa
 * por acá, y por eso acá viven las reglas de buen vecino con un servicio público:
 *
 * - **Token cacheado** por contribuyente y ambiente (25 min, conservador; el SII no publica la vida
 *   exacta). Pedir uno por llamada es lento y maltrata el servicio.
 * - **Re-autenticación una sola vez** ante un rechazo por token (HTTP 401/403 en el WS de registro;
 *   estados 001/002/003 en QueryEstDte). Si con un token nuevo vuelve a fallar, es otra cosa.
 * - **Reintentos con backoff** sólo ante fallas transitorias (red, 5xx, 429, `codResp` −1). Todas
 *   las operaciones son idempotentes —registrar un evento dos veces responde 7 "ya registrado"—, así
 *   que reintentar no duplica nada.
 * - **Concurrencia acotada** hacia el SII (por defecto 4 llamadas a la vez en todo el proceso).
 *
 * Ningún byte sale a otro host que no sea `*.sii.cl`, y ni el certificado ni el token se loguean.
 */

/** El User-Agent que el SII exige en sus CGI (ver `belen-abos/api/workers/dte-sii.ts`). */
export const USER_AGENT_SII = "Mozilla/4.0 ( compatible; PROG 1.0; Windows NT)";

const URL_PADRON: Record<AmbienteSii, string> = {
  produccion: "https://palena.sii.cl/cvc_cgi/dte/ee_empresa_rut",
  certificacion: "https://maullin.sii.cl/cvc_cgi/dte/ee_empresa_rut",
};

export class ErrorSii extends Error {
  constructor(
    readonly codigo:
      | "SII_INALCANZABLE"
      | "SII_RESPUESTA_INVALIDA"
      | "SII_SIN_SEMILLA"
      | "SII_SIN_TOKEN"
      | "SII_TOKEN_RECHAZADO"
      | "SII_FAULT"
      | "SII_SIN_CODIGO"
      | "SII_CAPTCHA",
    mensaje: string,
    readonly transitorio: boolean,
  ) {
    super(mensaje);
    this.name = "ErrorSii";
  }
}

/** Para quién se habla con el SII. El certificado se pide sólo si hace falta un token nuevo. */
export interface ContextoSii {
  /** Identifica el caché de token (el id del contribuyente). */
  clave: string;
  ambiente: AmbienteSii;
  certificado: () => Promise<CertificadoFirmante>;
}

export interface OpcionesCliente {
  fetch?: typeof fetch;
  ahora?: () => Date;
  vidaTokenMs?: number;
  timeoutMs?: number;
  /** Reintentos ADICIONALES ante fallas transitorias. */
  reintentos?: number;
  esperaBaseMs?: number;
  concurrencia?: number;
  dormir?: (ms: number) => Promise<void>;
}

const texto = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

export class ClienteSii {
  private readonly f: typeof fetch;
  private readonly ahora: () => Date;
  private readonly vidaTokenMs: number;
  private readonly timeoutMs: number;
  private readonly reintentos: number;
  private readonly esperaBaseMs: number;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly tokens = new Map<string, { token: string; expira: number }>();
  /** Pedidos de token en vuelo: dos llamadas simultáneas comparten UN canje de semilla. */
  private readonly tokensEnVuelo = new Map<string, Promise<string>>();
  private readonly cupos: number;
  private enUso = 0;
  private readonly cola: Array<() => void> = [];

  constructor(o: OpcionesCliente = {}) {
    this.f = o.fetch ?? fetch;
    this.ahora = o.ahora ?? (() => new Date());
    this.vidaTokenMs = o.vidaTokenMs ?? 25 * 60 * 1000;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.reintentos = o.reintentos ?? 3;
    this.esperaBaseMs = o.esperaBaseMs ?? 1_000;
    this.cupos = o.concurrencia ?? 4;
    this.dormir = o.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ── Transporte ──────────────────────────────────────────────────────────────────────────────

  /**
   * Semáforo: al liberar, el cupo pasa DIRECTO al siguiente en la cola (sin bajar el contador), así
   * nadie que llegue en ese instante se cuela por encima del tope.
   */
  private async conCupo<T>(fn: () => Promise<T>): Promise<T> {
    if (this.enUso < this.cupos) this.enUso++;
    else await new Promise<void>((r) => this.cola.push(r));
    try {
      return await fn();
    } finally {
      const siguiente = this.cola.shift();
      if (siguiente) siguiente();
      else this.enUso--;
    }
  }

  /**
   * Un POST al SII con reintentos ante fallas transitorias. Devuelve el cuerpo. Un 401/403 se
   * devuelve como `SII_TOKEN_RECHAZADO` (no se reintenta acá: lo resuelve quien tiene el token).
   */
  async post(url: string, init: { cuerpo: string; contentType: string; token?: string }, que: string): Promise<string> {
    if (!/^https:\/\/[\w.-]+\.sii\.cl\//.test(url)) throw new Error(`URL fuera del SII: ${url}`);
    let ultimo: ErrorSii | null = null;
    for (let intento = 0; intento <= this.reintentos; intento++) {
      if (intento > 0) {
        const espera = this.esperaBaseMs * 2 ** (intento - 1);
        await this.dormir(espera + Math.floor(Math.random() * (espera / 2)));
      }
      try {
        return await this.conCupo(() => this.postUnaVez(url, init, que));
      } catch (e) {
        if (!(e instanceof ErrorSii) || !e.transitorio) throw e;
        ultimo = e;
      }
    }
    throw ultimo!;
  }

  private async postUnaVez(url: string, init: { cuerpo: string; contentType: string; token?: string }, que: string): Promise<string> {
    let res: Response;
    try {
      res = await this.f(url, {
        method: "POST",
        headers: {
          "Content-Type": init.contentType,
          "User-Agent": USER_AGENT_SII,
          Accept: "*/*",
          ...(init.contentType.startsWith("text/xml") ? { SOAPAction: '""' } : {}),
          ...(init.token ? { Cookie: `TOKEN=${init.token}` } : {}),
        },
        body: init.cuerpo,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ErrorSii("SII_INALCANZABLE", `No se pudo contactar al SII (${que}): ${e instanceof Error ? e.message : String(e)}`, true);
    }
    const cuerpo = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new ErrorSii("SII_TOKEN_RECHAZADO", `El SII rechazó la autenticación (${que}): HTTP ${res.status}`, false);
    }
    if (res.status === 429 || res.status >= 500) {
      // Un 500 con SOAP Fault de negocio no es transitorio: el SII contestó, y contestó que no.
      const fault = faultDe(cuerpo);
      if (fault && res.status === 500 && !/internal error/i.test(fault)) {
        throw new ErrorSii("SII_FAULT", `El SII respondió un error (${que}): ${fault}`, false);
      }
      throw new ErrorSii("SII_RESPUESTA_INVALIDA", `El SII respondió ${res.status} (${que}): ${texto(cuerpo)}`, true);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ErrorSii("SII_RESPUESTA_INVALIDA", `El SII respondió ${res.status} (${que}): ${texto(cuerpo)}`, false);
    }
    return cuerpo;
  }

  // ── Token semilla → token ───────────────────────────────────────────────────────────────────

  async semilla(ambiente: AmbienteSii): Promise<string> {
    const cuerpo =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soapenv:Body><getSeed/></soapenv:Body></soapenv:Envelope>`;
    const r = await this.post(`${BASE_DTEWS[ambiente]}/CrSeed.jws`, { cuerpo, contentType: "text/xml; charset=utf-8" }, "pedir la semilla");
    const semilla = extraerSemilla(r);
    if (!semilla) throw new ErrorSii("SII_SIN_SEMILLA", `El SII no devolvió una semilla: ${texto(r)}`, true);
    return semilla;
  }

  async token(ctx: ContextoSii): Promise<string> {
    const k = `${ctx.clave}:${ctx.ambiente}`;
    const cacheado = this.tokens.get(k);
    if (cacheado && cacheado.expira > this.ahora().getTime()) return cacheado.token;
    const enVuelo = this.tokensEnVuelo.get(k);
    if (enVuelo) return enVuelo;
    const p = this.pedirToken(ctx).finally(() => this.tokensEnVuelo.delete(k));
    this.tokensEnVuelo.set(k, p);
    return p;
  }

  private async pedirToken(ctx: ContextoSii): Promise<string> {
    const semilla = await this.semilla(ctx.ambiente);
    const getToken = construirGetToken(semilla, await ctx.certificado());
    // El SII espera el XML firmado ESCAPADO dentro del SOAP: es un string, no un nodo.
    const escapado = getToken.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cuerpo =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">` +
      `<soapenv:Body><getToken><pszXml>${escapado}</pszXml></getToken></soapenv:Body></soapenv:Envelope>`;
    const r = await this.post(
      `${BASE_DTEWS[ctx.ambiente]}/GetTokenFromSeed.jws`,
      { cuerpo, contentType: "text/xml; charset=utf-8" },
      "canjear la semilla por un token",
    );
    const token = extraerToken(r);
    if (!token) {
      throw new ErrorSii(
        "SII_SIN_TOKEN",
        "El SII no devolvió un token. Suele ser el certificado: vencido, revocado, o su titular no es " +
          `usuario autorizado del contribuyente. Respuesta: ${texto(r)}`,
        false,
      );
    }
    this.tokens.set(`${ctx.clave}:${ctx.ambiente}`, { token, expira: this.ahora().getTime() + this.vidaTokenMs });
    return token;
  }

  /** Hay que llamarla al rotar el certificado: el token viejo sigue vivo hasta 25 min. */
  invalidarToken(clave: string): void {
    for (const k of [...this.tokens.keys()]) if (k.startsWith(`${clave}:`)) this.tokens.delete(k);
  }

  /** Corre `fn` con un token; si el SII lo rechaza, re-autentica UNA vez y repite. */
  private async conToken<T>(ctx: ContextoSii, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.token(ctx));
    } catch (e) {
      if (!(e instanceof ErrorSii) || e.codigo !== "SII_TOKEN_RECHAZADO") throw e;
      this.invalidarToken(ctx.clave);
      return fn(await this.token(ctx));
    }
  }

  // ── Registro de aceptación/reclamo ──────────────────────────────────────────────────────────

  private async registro(ctx: ContextoSii, cuerpo: string, que: string): Promise<string> {
    return this.conToken(ctx, async (token) => {
      const r = await this.post(URL_REGISTRO_RECLAMO[ctx.ambiente], { cuerpo, contentType: "text/xml; charset=utf-8", token }, que);
      const fault = faultDe(r);
      if (fault) throw new ErrorSii("SII_FAULT", `El registro del SII respondió un error (${que}): ${fault}`, false);
      return r;
    });
  }

  /** `codResp` −1 es "error interno, reintente": se reintenta acá con el mismo backoff. */
  private async registroConCodigo(ctx: ContextoSii, cuerpo: string, que: string) {
    for (let intento = 0; ; intento++) {
      const crudo = await this.registro(ctx, cuerpo, que);
      const r = parsearRespuesta(crudo);
      if (!r) throw new ErrorSii("SII_SIN_CODIGO", `El registro del SII no devolvió un código (${que}): ${texto(crudo)}`, true);
      if (r.codigo !== -1 || intento >= this.reintentos) return { ...r, crudo };
      await this.dormir(this.esperaBaseMs * 2 ** intento);
    }
  }

  async registrarAccion(
    ctx: ContextoSii,
    doc: DocumentoSii,
    accion: AccionReclamo,
  ): Promise<{ codigo: number; glosa: string; resultado: ResultadoAccion; crudo: string }> {
    const r = await this.registroConCodigo(ctx, sobreIngresarAccion(doc, accion), `registrar ${accion}`);
    return { ...r, resultado: clasificarAccion(r.codigo, accion, r.glosa) };
  }

  async listarEventos(ctx: ContextoSii, doc: DocumentoSii): Promise<{ codigo: number; glosa: string; eventos: EventoSii[] }> {
    const r = await this.registroConCodigo(ctx, sobreListarEventos(doc), "listar los eventos");
    return { codigo: r.codigo, glosa: r.glosa, eventos: r.codigo === 15 ? parsearEventos(r.crudo) : [] };
  }

  async consultarCedible(ctx: ContextoSii, doc: DocumentoSii): Promise<{ codigo: number; glosa: string; cedibilidad: Cedibilidad }> {
    const r = await this.registroConCodigo(ctx, sobreConsultarCedible(doc), "consultar si es cedible");
    return { codigo: r.codigo, glosa: r.glosa, cedibilidad: clasificarCedible(r.codigo) };
  }

  /** La fecha-hora de recepción en el SII (ISO con offset), o `null` si el SII no la tiene. */
  async fechaRecepcion(ctx: ContextoSii, doc: DocumentoSii): Promise<string | null> {
    return parsearFechaRecepcion(await this.registro(ctx, sobreFechaRecepcion(doc), "consultar la fecha de recepción"));
  }

  // ── Estado de un DTE ────────────────────────────────────────────────────────────────────────

  private async estado(ctx: ContextoSii, servicio: string, armar: (token: string) => string, que: string): Promise<EstadoDte> {
    const una = async (token: string) => {
      const r = await this.post(`${BASE_DTEWS[ctx.ambiente]}/${servicio}`, { cuerpo: armar(token), contentType: "text/xml; charset=utf-8" }, que);
      const e = parsearEstadoDte(r);
      if (!e) throw new ErrorSii("SII_RESPUESTA_INVALIDA", `El SII no devolvió un estado (${que}): ${texto(r)}`, true);
      // Acá el token viaja en el cuerpo y su rechazo vuelve como ESTADO 001/002/003, no como HTTP.
      if (e.clase === "token") throw new ErrorSii("SII_TOKEN_RECHAZADO", `Token rechazado por el SII (${e.estado})`, false);
      return e;
    };
    return this.conToken(ctx, una);
  }

  async estadoDte(ctx: ContextoSii, c: ConsultaEstadoDte): Promise<EstadoDte> {
    return this.estado(ctx, "QueryEstDte.jws", (t) => sobreEstadoDte(c, t), "consultar el estado del DTE");
  }


  // ── Padrón público ──────────────────────────────────────────────────────────────────────────

  /**
   * El padrón de emisores electrónicos (consulta pública uno a uno, Res. Ex. SII 45/2003). Va a
   * palena salvo que se pida el de certificación: es una pregunta sobre el mundo real.
   */
  async padron(rut: string, ambiente: AmbienteSii = "produccion"): Promise<ResultadoPadron> {
    const m = /^(\d{1,8})-([\dkK])$/.exec(rut);
    if (!m) throw new Error(`RUT con formato inesperado para el padrón: ${rut}`);
    const crudo = await this.conCupo(async () => {
      let res: Response;
      try {
        res = await this.f(URL_PADRON[ambiente], {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT_SII },
          body: new URLSearchParams({ RUT_EMP: m[1]!, DV_EMP: m[2]!.toUpperCase() }).toString(),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        throw new ErrorSii("SII_INALCANZABLE", `No se pudo consultar el padrón del SII: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      if (!res.ok) throw new ErrorSii("SII_RESPUESTA_INVALIDA", `El padrón del SII respondió ${res.status}.`, res.status >= 500);
      // El SII sirve la ficha en ISO-8859-1.
      return Buffer.from(await res.arrayBuffer()).toString("latin1");
    });
    return interpretarPadron(crudo);
  }
}
