import { firmarDocumento, type CertificadoFirmante } from "./dte-firma";

/**
 * Autenticación ante el SII: la semilla firmada con la que se pide el token.
 *
 * ## El protocolo, en tres pasos
 *
 * 1. Se pide una **semilla** (`getSeed`), que es un número de un solo uso y con vida corta.
 * 2. Se **firma** con el certificado digital del contribuyente y se manda de vuelta (`getToken`).
 * 3. El SII devuelve un **token**, que viaja como cookie en la subida del documento.
 *
 * Este módulo cubre el paso 2, que es el único con criptografía. Los pasos 1 y 3 son HTTP y viven
 * en `workers/dte-sii.ts`.
 *
 * ## Por qué la referencia va vacía
 *
 * El `<getToken>` no tiene ningún elemento con `ID` al que apuntar, así que la firma referencia el
 * **documento entero** (`URI=""`) y la transformada `enveloped-signature` excluye la propia firma
 * del digest. Es la misma mecánica del DTE, con la referencia vacía en vez de `#id`.
 *
 * Dominio puro: no toca red, disco ni base de datos.
 */

/** El documento sobre el que se calcula el digest: la semilla SIN la firma. */
function getTokenSinFirma(semilla: string): string {
  return `<getToken><item><Semilla>${semilla}</Semilla></item></getToken>`;
}

/**
 * Arma el `<getToken>` firmado que se le manda al SII para canjear la semilla por un token.
 *
 * La semilla se valida en vez de escaparse: el SII entrega dígitos, y cualquier otra cosa en ese
 * lugar sería una respuesta que no entendimos o una inyección. Escaparla la rompería en silencio
 * —el digest se calcularía sobre un texto y el SII verificaría contra otro—, así que es preferible
 * cortar acá.
 */
export function construirGetToken(semilla: string, cert: CertificadoFirmante): string {
  const limpia = semilla.trim();
  if (!/^\d+$/.test(limpia)) {
    throw new Error(
      `La semilla del SII no es numérica (${JSON.stringify(semilla.slice(0, 40))}). ` +
        `Suele significar que la respuesta de CrSeed no se pudo interpretar.`,
    );
  }
  const documento = getTokenSinFirma(limpia);
  const firma = firmarDocumento(documento, "", cert);
  return (
    `<?xml version="1.0" encoding="ISO-8859-1"?>` +
    `<getToken><item><Semilla>${limpia}</Semilla></item>${firma}</getToken>`
  );
}

/**
 * Rescata la semilla de la respuesta de `CrSeed`.
 *
 * La respuesta es un SOAP que trae un XML **escapado** adentro, así que hay que desescapar antes de
 * buscar la etiqueta. Se hace por texto y no con un parser porque el cuerpo trae ruido alrededor.
 */
export function extraerSemilla(respuesta: string): string | null {
  const plano = respuesta
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return plano.match(/<SEMILLA>\s*(\d+)\s*<\/SEMILLA>/i)?.[1] ?? null;
}

/** Rescata el token de la respuesta de `getToken`. Mismo tratamiento que la semilla. */
export function extraerToken(respuesta: string): string | null {
  const plano = respuesta
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return plano.match(/<TOKEN>\s*([A-Za-z0-9_-]+)\s*<\/TOKEN>/i)?.[1] ?? null;
}

/** Rescata el `TRACKID` de la respuesta de la subida. */
export function extraerTrackId(respuesta: string): string | null {
  const plano = respuesta
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return plano.match(/<TRACKID>\s*(\d+)\s*<\/TRACKID>/i)?.[1] ?? null;
}

/**
 * Estado que el SII reporta de un envío ya subido.
 *
 * El `trackId` acusa RECEPCIÓN; esto es lo que dice si además fue ACEPTADO. Son dos cosas distintas
 * y confundirlas es creer que un documento está declarado cuando fue rechazado.
 */
export interface EstadoEnvioSii {
  /** Código del SII. `EPR` es el caso feliz: procesado y aceptado. */
  estado: string;
  /** Texto del SII. Es lo que hay que mostrarle a quien tenga que resolverlo. */
  glosa: string | null;
  /** Cuántos documentos del envío aceptó, rechazó y reparó. Ausentes si todavía no procesó. */
  aceptados: number | null;
  rechazados: number | null;
  reparos: number | null;
}

/**
 * Códigos de `getEstUp` que significan «el SII terminó de procesar y lo aceptó».
 *
 * `EPR` = Envío Procesado. El resto —`SOK` recibido, `RCT`/`RFR` rechazado, `RPR` procesado con
 * reparos, `RCH` rechazado— o son transitorios o son malas noticias, y ninguno de los dos autoriza
 * a marcar el documento como declarado.
 */
const ESTADOS_ACEPTADO = new Set(["EPR"]);

/** ¿El SII terminó de procesar el envío y lo dio por bueno? */
export function envioAceptado(e: EstadoEnvioSii): boolean {
  // Aceptado de verdad: procesado, sin ningún documento rechazado.
  return ESTADOS_ACEPTADO.has(e.estado) && (e.rechazados ?? 0) === 0;
}

/** Lee la respuesta de `getEstUp`. Mismo tratamiento de escapado que la semilla y el token. */
export function extraerEstadoEnvio(respuesta: string): EstadoEnvioSii | null {
  const plano = respuesta
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  const estado = plano.match(/<ESTADO>\s*([A-Z0-9]+)\s*<\/ESTADO>/i)?.[1];
  if (!estado) return null;

  const num = (tag: string): number | null => {
    const v = plano.match(new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`, "i"))?.[1];
    return v === undefined ? null : Number(v);
  };

  return {
    estado,
    glosa: plano.match(/<GLOSA>\s*([\s\S]*?)\s*<\/GLOSA>/i)?.[1] ?? null,
    aceptados: num("ACEPTADOS"),
    rechazados: num("RECHAZADOS"),
    reparos: num("REPAROS"),
  };
}

/**
 * Base de las URL del SII según el ambiente.
 *
 * **Esto es un parámetro, no una constante.** El SDK del proveedor tiene justamente ese defecto:
 * su login sí respeta el ambiente (`class.factronica.loginsii.php:33-35`) pero la subida va fija a
 * palena (`index.php:185`), y el resultado es un token de maullin que palena rechaza. Emitir a
 * certificación con un token de producción —o al revés— es el error más caro de este dominio.
 */
export function baseSii(ambiente: "certificacion" | "produccion"): string {
  return ambiente === "produccion" ? "https://palena.sii.cl" : "https://maullin.sii.cl";
}
