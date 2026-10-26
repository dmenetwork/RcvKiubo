import { Agent, fetch as undiciFetch } from "undici";
import type { CertificadoFirmante } from "../core/dte-firma";
import {
  BASE_RCV,
  URL_FACADE,
  cuerpoRcv,
  datosDetalle,
  datosResumen,
  normalizarResumen,
  parsearRespuestaRcv,
  respuestaPideCaptcha,
  type FilaDetalleSii,
  type FilaResumenSii,
  type MetodoRcv,
  type ResumenRcv,
} from "../core/rcv-portal";
import type { EstadoRcv, OperacionRcv } from "../core/rcv-csv";
import { ErrorSii } from "./cliente";

/**
 * Sesión en el portal del SII con el certificado digital como cliente TLS, y las consultas del RCV.
 *
 * El login es el flujo de MiSII con certificado que Kiubo ya usa en producción para el timbraje
 * automático de folios (`belen-abos/api/workers/sii-folios.ts`, `autenticarPortal`): GET inicio →
 * POST `CAutInicio.cgi` → GET `ValidaLoginCertificado.cgi` → cookie `TOKEN`. Acá en Node, con el
 * certificado en un `Agent` de undici.
 *
 * Ningún pedido sale a un host que no sea `*.sii.cl` (también tras una redirección), la llave vive en
 * memoria lo que dura la sesión, y nunca se manda un token o campo de captcha.
 */

const URL_INICIO = "https://zeusr.sii.cl/AUT2000/InicioAutenticacion/IngresoRutClave.html";
const URL_LOGIN = "https://herculesr.sii.cl/cgi_AUT2000/CAutInicio.cgi";
const URL_VALIDA = "https://zeusr.sii.cl/AUT2000/InicioAutenticacion/ValidaLoginCertificado.cgi";
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) RcvKiubo/1.0";

/** Lo mínimo de `fetch` que se usa: inyectable en los tests. */
export type FetchPortal = (url: string, init: Record<string, unknown>) => Promise<Response>;

export interface OpcionesPortal {
  fetch?: FetchPortal;
  timeoutMs?: number;
  reintentos?: number;
  dormir?: (ms: number) => Promise<void>;
}

function pem(x509Base64: string): string {
  return `-----BEGIN CERTIFICATE-----\n${x509Base64.replace(/\s+/g, "").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export class SesionRcv {
  private readonly cookies = new Map<string, string>();
  private token: string | null = null;

  private constructor(
    private readonly f: FetchPortal,
    private readonly agente: Agent | null,
    private readonly o: Required<Omit<OpcionesPortal, "fetch">>,
  ) {}

  /** Abre la sesión de MiSII con el certificado. `rutTitular` = el RUT del dueño del certificado. */
  static async abrir(firmante: CertificadoFirmante, rutTitular: string, o: OpcionesPortal = {}): Promise<SesionRcv> {
    const agente = o.fetch ? null : new Agent({ connect: { cert: pem(firmante.x509), key: firmante.llavePrivadaPem } });
    const f: FetchPortal = o.fetch ?? ((url, init) => undiciFetch(url, init as never) as unknown as Promise<Response>);
    const s = new SesionRcv(f, agente, {
      timeoutMs: o.timeoutMs ?? 60_000,
      reintentos: o.reintentos ?? 2,
      dormir: o.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    });
    const [cuerpo, dv] = rutTitular.split("-") as [string, string];
    await s.llamar(URL_INICIO, { method: "GET" }, "iniciar sesión");
    await s.llamar(
      URL_LOGIN,
      { method: "POST", form: { rut: cuerpo, dv: dv.toUpperCase(), rutcntr: `${cuerpo}-${dv.toUpperCase()}`, referencia: URL_INICIO, "411": "" } },
      "autenticar el certificado",
    );
    await s.llamar(URL_VALIDA, { method: "GET" }, "validar el login");
    s.token = s.cookies.get("TOKEN") ?? null;
    if (!s.token) {
      throw new ErrorSii(
        "SII_SIN_TOKEN",
        "El portal del SII no autenticó el certificado. Revisa que esté vigente y que el titular sea usuario autorizado del contribuyente.",
        false,
      );
    }
    // La aplicación del RCV siembra sus propias cookies al entrar.
    await s.llamar(`${BASE_RCV}/`, { method: "GET" }, "abrir el RCV");
    return s;
  }

  /** Una llamada siguiendo redirecciones A MANO (las cookies de cada salto quedan en la sesión). */
  private async llamar(
    url: string,
    init: { method: "GET" | "POST"; form?: Record<string, string>; json?: string },
    que: string,
  ): Promise<string> {
    let ultimo: ErrorSii | null = null;
    for (let intento = 0; intento <= this.o.reintentos; intento++) {
      if (intento > 0) await this.o.dormir(1_000 * 2 ** (intento - 1));
      try {
        return await this.llamarUnaVez(url, init, que);
      } catch (e) {
        if (!(e instanceof ErrorSii) || !e.transitorio) throw e;
        ultimo = e;
      }
    }
    throw ultimo!;
  }

  private async llamarUnaVez(url: string, init: { method: "GET" | "POST"; form?: Record<string, string>; json?: string }, que: string): Promise<string> {
    let actual = url;
    let metodo = init.method;
    let body: string | undefined = init.form ? new URLSearchParams(init.form).toString() : init.json;
    let tipo = init.form ? "application/x-www-form-urlencoded" : init.json ? "application/json" : undefined;
    for (let salto = 0; salto < 6; salto++) {
      if (!/^https:\/\/[\w.-]+\.sii\.cl\//.test(actual)) throw new ErrorSii("SII_RESPUESTA_INVALIDA", `El portal redirigió fuera del SII (${que}).`, false);
      let res: Response;
      try {
        res = await this.f(actual, {
          method: metodo,
          headers: {
            "User-Agent": USER_AGENT,
            Accept: init.json ? "application/json, text/plain, */*" : "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "es-CL,es;q=0.9",
            ...(init.json ? { Referer: `${BASE_RCV}/` } : {}),
            ...(tipo && body !== undefined ? { "Content-Type": tipo } : {}),
            ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(this.o.timeoutMs),
          ...(this.agente ? { dispatcher: this.agente } : {}),
        });
      } catch (e) {
        throw new ErrorSii("SII_INALCANZABLE", `No se pudo contactar al portal del SII (${que}): ${e instanceof Error ? e.message : String(e)}`, true);
      }
      for (const c of (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []) {
        const nv = c.split(";")[0] ?? "";
        const i = nv.indexOf("=");
        if (i > 0) this.cookies.set(nv.slice(0, i).trim(), nv.slice(i + 1).trim());
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        actual = new URL(res.headers.get("location")!, actual).toString();
        if (res.status !== 307 && res.status !== 308) {
          metodo = "GET";
          body = undefined;
          tipo = undefined;
        }
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const texto = await res.text();
      if (res.status >= 500 || res.status === 429) {
        throw new ErrorSii("SII_RESPUESTA_INVALIDA", `El portal del SII respondió ${res.status} (${que}).`, true);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new ErrorSii("SII_RESPUESTA_INVALIDA", `El portal del SII respondió ${res.status} (${que}).`, false);
      }
      return texto;
    }
    throw new ErrorSii("SII_RESPUESTA_INVALIDA", `Demasiadas redirecciones del portal del SII (${que}).`, false);
  }

  private async consultar<T>(metodo: MetodoRcv, data: Record<string, unknown>, que: string): Promise<T[]> {
    const texto = await this.llamar(`${URL_FACADE}/${metodo}`, { method: "POST", json: cuerpoRcv(metodo, this.token!, data) }, que);
    if (respuestaPideCaptcha(texto)) {
      throw new ErrorSii(
        "SII_CAPTCHA",
        "El SII pidió captcha para el RCV. RcvKiubo no lo resuelve ni lo burla: la sincronización se detiene; mientras tanto, descarga el CSV del portal e impórtalo.",
        false,
      );
    }
    try {
      return parsearRespuestaRcv<T>(texto).filas;
    } catch (e) {
      throw new ErrorSii("SII_RESPUESTA_INVALIDA", `${que}: ${e instanceof Error ? e.message : String(e)}`, false);
    }
  }

  async resumen(rutEmpresa: string, periodo: string, operacion: OperacionRcv, estado: EstadoRcv): Promise<ResumenRcv[]> {
    const filas = await this.consultar<FilaResumenSii>("getResumen", datosResumen(rutEmpresa, periodo, operacion, estado), `resumen ${operacion} ${estado} ${periodo}`);
    return filas.map(normalizarResumen);
  }

  async detalle(rutEmpresa: string, periodo: string, operacion: OperacionRcv, estado: EstadoRcv | "", tipoDte: number): Promise<FilaDetalleSii[]> {
    const metodo = operacion === "COMPRA" ? "getDetalleCompra" : "getDetalleVenta";
    return this.consultar<FilaDetalleSii>(metodo, datosDetalle(rutEmpresa, periodo, operacion, estado, tipoDte), `detalle ${operacion} ${estado || "-"} tipo ${tipoDte} ${periodo}`);
  }

  async cerrar(): Promise<void> {
    await this.agente?.close().catch(() => {});
  }
}
