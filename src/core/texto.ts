/**
 * Texto que viaja dentro de un XML declarado ISO-8859-1.
 *
 * Extraído de `belen-abos/api/core/dte-txt.ts` (solo la parte que usa la firma). Dominio puro.
 */

const EQUIVALENTES_LATIN1: Record<string, string> = {
  "‘": "'", "’": "'", // comillas simples curvas
  "“": '"', "”": '"', // comillas dobles curvas
  "–": "-", "—": "-", // guion medio y largo
  "…": ".",                // puntos suspensivos (1:1, se pierde precisión a propósito)
  " ": " ",                // espacio duro
};

/**
 * Deja el texto dentro de lo que ISO-8859-1 puede representar.
 *
 * `Buffer.from(s, "latin1")` NO reemplaza lo que no existe en Latin-1: **trunca al byte bajo**. Una
 * comilla tipográfica (U+201C) se convierte en 0x1C, un carácter de control que el XML 1.0 prohíbe,
 * y el documento queda inválido — y se firma igual. Lo que tiene equivalente ASCII se translitera; el
 * resto pasa a `?`, que es lo que haría `utf8_decode` del lado PHP.
 */
export function normalizarLatin1(valor: string): string {
  let out = "";
  for (const ch of valor) {
    const equivalente = EQUIVALENTES_LATIN1[ch];
    if (equivalente !== undefined) {
      out += equivalente;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    // Fuera de Latin-1, o carácter de control que el XML no admite (salvo tab/salto de línea).
    if (cp > 0xff || (cp < 0x20 && ch !== "\n" && ch !== "\r" && ch !== "\t")) {
      out += "?";
      continue;
    }
    out += ch;
  }
  return out;
}
