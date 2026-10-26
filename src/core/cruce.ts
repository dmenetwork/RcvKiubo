/**
 * Cruce de dos listas de documentos por su identidad tributaria: (RUT contraparte, tipo, folio).
 *
 * Es la pregunta que el RCV existe para responder: "¿qué tiene el SII que yo no tengo, y al revés?".
 * Una factura que el SII registró y que nunca llegó al buzón es IVA crédito que se pierde o una
 * factura que alguien no va a pagar; una que tengo y el SII no, es una que no se puede declarar.
 *
 * Dominio puro y genérico: no sabe de dónde viene cada lado.
 */

export interface DocumentoCruzable {
  rutContraparte: string;
  tipoDte: number;
  folio: number;
  montoTotal?: number | null;
  /** `AAAA-MM-DD`. */
  fechaEmision?: string | null;
}

export function claveCruce(d: Pick<DocumentoCruzable, "rutContraparte" | "tipoDte" | "folio">): string {
  return `${d.rutContraparte.toUpperCase()}|${d.tipoDte}|${d.folio}`;
}

export interface Diferencia<A, B> {
  a: A;
  b: B;
  /** Qué no coincide: `montoTotal`, `fechaEmision`. */
  campos: Array<"montoTotal" | "fechaEmision">;
}

export interface ResultadoCruce<A, B> {
  soloEnA: A[];
  soloEnB: B[];
  diferencias: Array<Diferencia<A, B>>;
  coinciden: number;
  /** Claves repetidas dentro de un mismo lado: un archivo con la misma factura dos veces. */
  duplicadosA: string[];
  duplicadosB: string[];
}

function indexar<T extends DocumentoCruzable>(xs: readonly T[]): { mapa: Map<string, T>; duplicados: string[] } {
  const mapa = new Map<string, T>();
  const duplicados: string[] = [];
  for (const x of xs) {
    const k = claveCruce(x);
    if (mapa.has(k)) duplicados.push(k);
    else mapa.set(k, x);
  }
  return { mapa, duplicados };
}

/**
 * Compara A contra B. Un monto o una fecha AUSENTES en un lado no cuentan como diferencia: sólo se
 * compara lo que ambos lados declaran.
 */
export function cruzar<A extends DocumentoCruzable, B extends DocumentoCruzable>(
  a: readonly A[],
  b: readonly B[],
): ResultadoCruce<A, B> {
  const ia = indexar(a);
  const ib = indexar(b);
  const soloEnA: A[] = [];
  const diferencias: Array<Diferencia<A, B>> = [];
  let coinciden = 0;
  for (const [k, x] of ia.mapa) {
    const y = ib.mapa.get(k);
    if (!y) {
      soloEnA.push(x);
      continue;
    }
    const campos: Diferencia<A, B>["campos"] = [];
    if (x.montoTotal != null && y.montoTotal != null && x.montoTotal !== y.montoTotal) campos.push("montoTotal");
    if (x.fechaEmision && y.fechaEmision && x.fechaEmision !== y.fechaEmision) campos.push("fechaEmision");
    if (campos.length) diferencias.push({ a: x, b: y, campos });
    else coinciden++;
  }
  const soloEnB = [...ib.mapa].filter(([k]) => !ia.mapa.has(k)).map(([, y]) => y);
  return { soloEnA, soloEnB, diferencias, coinciden, duplicadosA: ia.duplicados, duplicadosB: ib.duplicados };
}
