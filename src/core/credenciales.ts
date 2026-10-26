import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API keys de los consumidores y firma de los webhooks. Dominio puro.
 *
 * Una API key se muestra UNA vez y se guarda su sha256: un dump de la base no entrega credenciales
 * usables (mismo criterio que KIU-400 en Kiubo con `hermes_tokens`). Como la key tiene 32 bytes
 * aleatorios, sha256 sin sal alcanza: no hay diccionario que probar.
 */

const PREFIJO = "rk_";

export function generarApiKey(): { clave: string; prefijo: string; hash: string } {
  const clave = PREFIJO + randomBytes(32).toString("base64url");
  return { clave, prefijo: clave.slice(0, 10), hash: hashApiKey(clave) };
}

export function hashApiKey(clave: string): string {
  return createHash("sha256").update(clave, "utf8").digest("hex");
}

export function pareceApiKey(v: string): boolean {
  return v.startsWith(PREFIJO) && v.length >= 40 && v.length <= 80;
}

/** Secreto para firmar los webhooks de un consumidor. */
export function generarSecretoWebhook(): string {
  return "whsec_" + randomBytes(32).toString("base64url");
}

/**
 * Cabecera `X-RcvKiubo-Firma: t=<unix>,v1=<hex>`, con `v1 = HMAC-SHA256(secreto, "<t>.<cuerpo>")`.
 * El timestamp va DENTRO de lo firmado: sin eso, un webhook capturado se podría reenviar para siempre.
 */
export function firmarWebhook(secreto: string, cuerpo: string, ahora: Date): string {
  const t = Math.floor(ahora.getTime() / 1000);
  const v1 = createHmac("sha256", secreto).update(`${t}.${cuerpo}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

/** Lo que tiene que hacer un consumidor al recibir un webhook. Se exporta para el README y los tests. */
export function verificarWebhook(
  cabecera: string,
  secreto: string,
  cuerpo: string,
  ahora: Date,
  toleranciaSeg = 300,
): boolean {
  const partes = Object.fromEntries(cabecera.split(",").map((p) => p.trim().split("=") as [string, string]));
  const t = Number(partes.t);
  if (!Number.isInteger(t) || !partes.v1) return false;
  if (Math.abs(ahora.getTime() / 1000 - t) > toleranciaSeg) return false;
  const esperado = createHmac("sha256", secreto).update(`${t}.${cuerpo}`, "utf8").digest();
  const recibido = Buffer.from(partes.v1, "hex");
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

/** Comparación en tiempo constante de dos secretos de texto (el del Email Worker, el de admin). */
export function secretoIgual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
