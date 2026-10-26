/**
 * Búsqueda de elementos XML en tiempo LINEAL, para texto que manda un desconocido.
 *
 * ## Por qué no `/<tag\b[^>]*>([\s\S]*?)<\/tag>/`
 *
 * Ese regex prueba cada `<tag` del texto y, por cada uno, recorre hasta el final buscando el cierre.
 * Con N aperturas sin cierre son N recorridos completos: tiempo cuadrático. Medido en el review del
 * buzón de intercambio (2026-10-15): 200 KB de `<DTE>` sin cerrar = 1,9 s; 8 MB ≈ 50 min, en el
 * mismo proceso que atiende el POS. Basta un correo a la casilla de intercambio, que el SII publica.
 *
 * ## Por qué esto da EXACTAMENTE lo mismo
 *
 * El regex devuelve la primera apertura válida que tenga un cierre después. Si la primera apertura
 * válida no tiene cierre después, ninguna posterior lo tiene (están más adelante), y si no tiene `>`
 * después, ninguna posterior lo tiene. Así que basta mirar la primera apertura válida: `indexOf` de
 * la apertura, del `>` y del cierre, y se corta ahí. Cada `indexOf` avanza, nunca vuelve.
 *
 * Dominio puro: no toca red, disco ni base de datos.
 */

/**
 * Qué cuenta como apertura de `<tag`, según el regex que reemplaza:
 * - `palabra`: `<tag\b[^>]*>`: lo que sigue al nombre no es letra, dígito ni `_`.
 * - `estricta`: `<tag(?:\s[^>]*)?>`: lo que sigue es `>` o un blanco.
 * - `exacta`: `<tag>`: sin atributos.
 */
export type Apertura = "palabra" | "estricta" | "exacta";

export interface Elemento {
  /** Índice del `<` de la apertura. */
  inicio: number;
  /** Índice del primer carácter después del `>` de la apertura. */
  contenidoInicio: number;
  /** Índice del `<` del cierre. */
  contenidoFin: number;
  /** Índice siguiente al `>` del cierre. */
  fin: number;
}

function aperturaValida(c: string, apertura: Apertura): boolean {
  if (apertura === "exacta") return c === ">";
  if (apertura === "estricta") return c === ">" || /\s/.test(c);
  return c === "" || !/[A-Za-z0-9_]/.test(c);
}

/** El primer `<tag …>…</tag>` desde `desde`, o `null`. Lineal en el largo del texto. */
export function elemento(xml: string, tag: string, apertura: Apertura = "palabra", desde = 0): Elemento | null {
  const abre = `<${tag}`;
  const cierra = `</${tag}>`;
  let i = xml.indexOf(abre, desde);
  while (i !== -1 && !aperturaValida(xml.charAt(i + abre.length), apertura)) {
    i = xml.indexOf(abre, i + 1);
  }
  if (i === -1) return null;
  const gt = xml.indexOf(">", i + abre.length);
  if (gt === -1) return null;
  const c = xml.indexOf(cierra, gt + 1);
  if (c === -1) return null;
  return { inicio: i, contenidoInicio: gt + 1, contenidoFin: c, fin: c + cierra.length };
}

/**
 * Todos los `<tag …>…</tag>` sin solaparse, en orden (lo que hace `matchAll` con `/g`). Con `max`
 * para de buscar al llegar: miles de `<DTE></DTE>` cerrados también son un ataque (memoria).
 */
export function elementos(xml: string, tag: string, apertura: Apertura = "palabra", max = Infinity): Elemento[] {
  const todos: Elemento[] = [];
  for (let e = elemento(xml, tag, apertura); e && todos.length < max; e = elemento(xml, tag, apertura, e.fin)) {
    todos.push(e);
  }
  return todos;
}

/** Contenido interno del primer `<tag>`, o `null`. */
export function contenidoDe(xml: string, tag: string, apertura: Apertura = "palabra"): string | null {
  const e = elemento(xml, tag, apertura);
  return e ? xml.slice(e.contenidoInicio, e.contenidoFin) : null;
}

/** El primer `<tag>…</tag>` completo, con sus etiquetas, o `null`. */
export function bloqueDe(xml: string, tag: string, apertura: Apertura = "palabra"): string | null {
  const e = elemento(xml, tag, apertura);
  return e ? xml.slice(e.inicio, e.fin) : null;
}
