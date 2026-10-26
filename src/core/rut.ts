/**
 * Validación y formateo de RUT chileno (lógica probada portada de GaelWebCore).
 * Dígito verificador por módulo 11: multiplicador cíclico 2..7, mapeo 11→0, 10→K.
 *
 * Compuerta dura sobre clientes/proveedores antes de emitir cualquier documento.
 */

/** RUT del consumidor genérico (boleta sin cliente identificado — caso por defecto del super). */
export const RUT_CONSUMIDOR_GENERICO = "66666666-6";
/** RUT receptor SII para el sobre de subida de DTE. */
export const RUT_RECEPTOR_SII = "60803000-K";

/** Quita puntos, guion y espacios; pasa a mayúscula (para la K). */
export function cleanRut(value: string): string {
  return value.replace(/[.\-\s]/g, "").toUpperCase();
}

/** Calcula el dígito verificador (mod 11) del cuerpo numérico. Devuelve "0".."9" o "K". */
export function computeDv(body: number): string {
  let sum = 0;
  let multiplier = 2;
  for (const ch of String(body).split("").reverse()) {
    sum += Number(ch) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const r = 11 - (sum % 11);
  if (r === 11) return "0";
  if (r === 10) return "K";
  return String(r);
}

/** true si el RUT es estructuralmente válido (cuerpo numérico + DV mod-11 correcto). */
export function isValidRut(value: string): boolean {
  const clean = cleanRut(value);
  if (clean.length < 2) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  if (!/^\d+$/.test(body)) return false;
  return computeDv(Number(body)) === dv;
}

/**
 * Forma que exige el SII en los DTE: cuerpo, guion y DV, SIN puntos (ej. `76086428-5`).
 *
 * El manual lo define así para RUTEmisor y RUTRecep: "Cuerpo numérico entre 100.000 y 99 millones,
 * guion y dígito verificador alfanumérico entre 0 y 9 o K" (`docs/formato_dte_pdf.md:298,332`).
 * `cleanRut` no sirve para esto: saca también el guion, que acá es obligatorio; y `formatRut` mete
 * puntos de miles, que el SII no admite.
 *
 * Devuelve "" si el valor no es un RUT válido: quien emite debe cortar antes, no mandar basura.
 */
export function rutSii(value: string): string {
  if (!isValidRut(value)) return "";
  const clean = cleanRut(value);
  return `${clean.slice(0, -1)}-${clean.slice(-1)}`;
}

/** Formatea con puntos de miles + "-DV" (ej. 76086428-5 → 76.086.428-5). */
export function formatRut(value: string): string {
  const clean = cleanRut(value);
  if (clean.length < 2) return clean;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  if (!/^\d+$/.test(body)) return clean;
  const withDots = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withDots}-${dv}`;
}
