import { rutSii } from "./rut";
import { esPeriodo, parsearFechaChilena } from "./fechas";

/**
 * Lectura del CSV que el portal del SII entrega en "Registro de Compras y Ventas → Descargar
 * detalles". Dominio puro.
 *
 * ## Por qué un CSV y no el portal
 *
 * Desde octubre de 2024 el detalle del RCV (`consdcvinternetui/.../facadeService`) exige un token de
 * reCAPTCHA Enterprise que genera el navegador de una persona. Este servicio no lo automatiza: una
 * persona baja el CSV (≈30 segundos al mes) y lo sube. Ver README, "Por qué no se automatiza el RCV".
 *
 * ## Por qué se lee por NOMBRE de columna
 *
 * El SII ha agregado columnas a estos archivos sin aviso, y compras, ventas y pendientes no traen las
 * mismas. Se lee el encabezado, se normaliza (minúsculas, sin tildes ni puntuación) y se mapea a los
 * campos conocidos; lo que no se reconoce queda en `extra` y no se pierde. Faltar una columna
 * OBLIGATORIA (tipo, RUT, folio) es error del archivo entero: sin esas tres no hay documento.
 *
 * **NO VERIFICADO con un archivo real**: los nombres de columna salen de archivos de terceros. Los
 * alias de `COLUMNAS` cubren las variantes vistas; un archivo real del cliente debería quedar como
 * fixture en `__fixtures__/rcv/`.
 */

export type OperacionRcv = "COMPRA" | "VENTA";
export type EstadoRcv = "REGISTRO" | "PENDIENTE" | "NO_INCLUIR" | "RECLAMADO";
export const ESTADOS_RCV: readonly EstadoRcv[] = ["REGISTRO", "PENDIENTE", "NO_INCLUIR", "RECLAMADO"];

export interface OtroImpuesto {
  codigo: number;
  valor: number | null;
  tasa: number | null;
}

export interface FilaRcv {
  /** Línea del archivo (1 = encabezado), para que un error se pueda encontrar. */
  linea: number;
  tipoDte: number;
  /** Forma SII `12345678-9`: proveedor en compras, cliente en ventas. */
  rutContraparte: string;
  razonSocial: string | null;
  folio: number;
  /** `AAAA-MM-DD`. */
  fechaEmision: string | null;
  /** ISO con offset de Santiago. Es el reloj de los 8 días. */
  fechaRecepcionSii: string | null;
  fechaAcuse: string | null;
  fechaReclamo: string | null;
  tipoTransaccion: string | null;
  montoExento: number | null;
  montoNeto: number | null;
  /** En compras, el IVA recuperable; en ventas, el IVA. */
  montoIva: number | null;
  montoIvaNoRecuperable: number | null;
  codigoIvaNoRecuperable: number | null;
  montoTotal: number | null;
  otrosImpuestos: OtroImpuesto[];
  /** Columnas no mapeadas, por su encabezado original. */
  extra: Record<string, string>;
}

export interface ResultadoCsv {
  operacion: OperacionRcv | null;
  filas: FilaRcv[];
  /** Filas que no se pudieron leer, con el motivo. No detienen el resto. */
  problemas: Array<{ linea: number; motivo: string }>;
  /** Encabezados que no se reconocieron (van a `extra`). Útil para detectar un cambio del SII. */
  columnasDesconocidas: string[];
}

/** `Monto IVA Recuperable` → `monto_iva_recuperable`. */
export function normalizarEncabezado(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

type Campo =
  | "nro" | "tipoDte" | "tipoTransaccion" | "rutContraparte" | "razonSocial" | "folio" | "fechaEmision"
  | "fechaRecepcionSii" | "fechaAcuse" | "fechaReclamo" | "montoExento" | "montoNeto" | "montoIva"
  | "montoIvaNoRecuperable" | "codigoIvaNoRecuperable" | "montoTotal" | "codigoOtroImpuesto"
  | "valorOtroImpuesto" | "tasaOtroImpuesto";

/** Alias normalizados → campo. Compras y ventas comparten lo que significa lo mismo. */
const COLUMNAS: Record<string, Campo> = {
  nro: "nro",
  tipo_doc: "tipoDte",
  tipo_docto: "tipoDte",
  tipo_compra: "tipoTransaccion",
  tipo_venta: "tipoTransaccion",
  rut_proveedor: "rutContraparte",
  rut_cliente: "rutContraparte",
  rut_receptor: "rutContraparte",
  razon_social: "razonSocial",
  folio: "folio",
  fecha_docto: "fechaEmision",
  fecha_documento: "fechaEmision",
  fecha_emision: "fechaEmision",
  fecha_recepcion: "fechaRecepcionSii",
  fecha_acuse: "fechaAcuse",
  fecha_acuse_recibo: "fechaAcuse",
  fecha_reclamo: "fechaReclamo",
  monto_exento: "montoExento",
  monto_neto: "montoNeto",
  monto_iva_recuperable: "montoIva",
  monto_iva: "montoIva",
  monto_iva_no_recuperable: "montoIvaNoRecuperable",
  codigo_iva_no_rec: "codigoIvaNoRecuperable",
  codigo_iva_no_recuperable: "codigoIvaNoRecuperable",
  monto_total: "montoTotal",
  codigo_otro_impuesto: "codigoOtroImpuesto",
  codigo_otro_imp: "codigoOtroImpuesto",
  valor_otro_impuesto: "valorOtroImpuesto",
  valor_otro_imp: "valorOtroImpuesto",
  tasa_otro_impuesto: "tasaOtroImpuesto",
  tasa_otro_imp: "tasaOtroImpuesto",
};

/** El SII sirve Latin-1 a veces y UTF-8 otras: UTF-8 estricto y, si falla, Latin-1. */
export function decodificarCsv(bytes: Buffer | string): string {
  if (typeof bytes === "string") return bytes.replace(/^﻿/, "");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return bytes.toString("latin1");
  }
}

/** Parte una línea respetando comillas dobles (`"a;b"` es UN campo; `""` es una comilla). */
export function partirLinea(linea: string, sep: string): string[] {
  const out: string[] = [];
  let actual = "";
  let enComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]!;
    if (enComillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (c === '"') enComillas = false;
      else actual += c;
    } else if (c === '"') enComillas = true;
    else if (c === sep) {
      out.push(actual);
      actual = "";
    } else actual += c;
  }
  out.push(actual);
  return out.map((s) => s.trim());
}

/** Entero CLP. Acepta `1234`, `-1234` y miles con punto (`1.234.567`). Vacío → `null`. */
export function entero(v: string | undefined): number | null {
  const s = (v ?? "").trim();
  if (s === "") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
  return Number.NaN;
}

/** Tasa con decimales: `20,5` o `20.5`. */
function decimal(v: string | undefined): number | null {
  const s = (v ?? "").trim().replace(",", ".");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function soloFecha(v: string | undefined): string | null {
  const iso = parsearFechaChilena(v);
  return iso ? iso.slice(0, 10) : null;
}

export function parsearRcvCsv(entrada: Buffer | string, opts: { operacion?: OperacionRcv } = {}): ResultadoCsv {
  const texto = decodificarCsv(entrada);
  const lineas = texto.split(/\r?\n/);
  const idxEnc = lineas.findIndex((l) => l.trim() !== "");
  if (idxEnc < 0) throw new Error("El archivo está vacío.");
  const encabezado = lineas[idxEnc]!;
  const sep = (encabezado.match(/;/g)?.length ?? 0) >= (encabezado.match(/,/g)?.length ?? 0) ? ";" : ",";
  const columnas = partirLinea(encabezado, sep);
  const normal = columnas.map(normalizarEncabezado);

  const posiciones = new Map<Campo, number[]>();
  const desconocidas: string[] = [];
  normal.forEach((n, i) => {
    const campo = COLUMNAS[n];
    if (campo) posiciones.set(campo, [...(posiciones.get(campo) ?? []), i]);
    else if (n !== "") desconocidas.push(columnas[i]!);
  });
  for (const req of ["tipoDte", "rutContraparte", "folio"] as const) {
    if (!posiciones.has(req)) {
      throw new Error(
        `El archivo no tiene la columna de ${req === "tipoDte" ? "tipo de documento" : req === "folio" ? "folio" : "RUT"}: ` +
          `no parece un detalle del RCV. Encabezado leído: ${columnas.join(" | ").slice(0, 300)}`,
      );
    }
  }

  const operacion: OperacionRcv | null =
    opts.operacion ??
    (normal.includes("rut_proveedor") ? "COMPRA" : normal.includes("rut_cliente") ? "VENTA" : null);

  const filas: FilaRcv[] = [];
  const problemas: ResultadoCsv["problemas"] = [];
  for (let i = idxEnc + 1; i < lineas.length; i++) {
    const linea = lineas[i]!;
    if (linea.trim() === "") continue;
    const nroLinea = i + 1;
    const celdas = partirLinea(linea, sep);
    const de = (c: Campo, k = 0): string | undefined => {
      const p = posiciones.get(c)?.[k];
      return p === undefined ? undefined : celdas[p];
    };

    const tipoDte = entero(de("tipoDte"));
    const folio = entero(de("folio"));
    const rut = rutSii(de("rutContraparte") ?? "");
    if (tipoDte === null || !Number.isInteger(tipoDte) || tipoDte <= 0 || tipoDte > 999) {
      problemas.push({ linea: nroLinea, motivo: `tipo de documento inválido: ${JSON.stringify(de("tipoDte"))}` });
      continue;
    }
    // Un folio fuera de INTEGER no es un folio: se informa en su línea en vez de tumbar el import.
    if (folio === null || !Number.isInteger(folio) || folio <= 0 || folio > 2_147_483_647) {
      // Las filas de resumen (boletas, totales) no traen folio: se informan, no se inventan.
      problemas.push({ linea: nroLinea, motivo: `sin folio válido (tipo ${tipoDte}): ${JSON.stringify(de("folio"))}` });
      continue;
    }
    if (!rut) {
      problemas.push({ linea: nroLinea, motivo: `RUT inválido: ${JSON.stringify(de("rutContraparte"))}` });
      continue;
    }

    const montos: Record<string, number | null> = {};
    let montoMalo: string | null = null;
    for (const c of ["montoExento", "montoNeto", "montoIva", "montoIvaNoRecuperable", "montoTotal"] as const) {
      const n = entero(de(c));
      if (n !== null && !Number.isInteger(n)) montoMalo = `${c}=${JSON.stringify(de(c))}`;
      montos[c] = n;
    }
    if (montoMalo) {
      problemas.push({ linea: nroLinea, motivo: `monto no entero: ${montoMalo}` });
      continue;
    }

    const otros: OtroImpuesto[] = [];
    const cuantos = posiciones.get("codigoOtroImpuesto")?.length ?? 0;
    for (let k = 0; k < cuantos; k++) {
      const codigo = entero(de("codigoOtroImpuesto", k));
      if (codigo === null || !Number.isInteger(codigo) || codigo <= 0) continue;
      const valor = entero(de("valorOtroImpuesto", k));
      otros.push({ codigo, valor: valor !== null && Number.isInteger(valor) ? valor : null, tasa: decimal(de("tasaOtroImpuesto", k)) });
    }

    const extra: Record<string, string> = {};
    normal.forEach((n, p) => {
      if (!COLUMNAS[n] && n !== "" && (celdas[p] ?? "") !== "") extra[columnas[p]!] = celdas[p]!;
    });

    const codIvaNoRec = entero(de("codigoIvaNoRecuperable"));
    filas.push({
      linea: nroLinea,
      tipoDte,
      rutContraparte: rut,
      razonSocial: de("razonSocial") || null,
      folio,
      fechaEmision: soloFecha(de("fechaEmision")),
      fechaRecepcionSii: parsearFechaChilena(de("fechaRecepcionSii")),
      fechaAcuse: parsearFechaChilena(de("fechaAcuse")),
      fechaReclamo: parsearFechaChilena(de("fechaReclamo")),
      tipoTransaccion: de("tipoTransaccion") || null,
      montoExento: montos.montoExento ?? null,
      montoNeto: montos.montoNeto ?? null,
      montoIva: montos.montoIva ?? null,
      montoIvaNoRecuperable: montos.montoIvaNoRecuperable ?? null,
      codigoIvaNoRecuperable: codIvaNoRec !== null && Number.isInteger(codIvaNoRec) ? codIvaNoRec : null,
      montoTotal: montos.montoTotal ?? null,
      otrosImpuestos: otros,
      extra,
    });
  }
  return { operacion, filas, problemas, columnasDesconocidas: desconocidas };
}

export interface MetadatosArchivoRcv {
  operacion: OperacionRcv | null;
  estado: EstadoRcv | null;
  rut: string | null;
  periodo: string | null;
}

/**
 * Lo que dice el nombre del archivo que entrega el portal, p. ej.
 * `RCV_COMPRA_REGISTRO_76123456-7_202410.csv` o `RCV_VENTA_77840802-3_202410.csv`.
 * Cada parte es opcional: un archivo renombrado no deja de ser válido.
 */
export function metadatosDeNombre(nombre: string): MetadatosArchivoRcv {
  const n = nombre.toUpperCase();
  const operacion = /\bCOMPRAS?\b|_COMPRAS?_/.test(n) ? "COMPRA" : /\bVENTAS?\b|_VENTAS?_/.test(n) ? "VENTA" : null;
  const estado = (ESTADOS_RCV.find((e) => n.includes(`_${e}_`) || n.includes(`_${e}.`)) ?? null) as EstadoRcv | null;
  const rut = /(\d{7,8}-[\dK])/.exec(n)?.[1] ?? null;
  const periodoCand = /(?:^|[_-])(\d{6})(?=[_.-]|$)/.exec(n.replace(/\.CSV$/, "") + "_")?.[1] ?? null;
  return {
    operacion,
    estado,
    rut: rut ? rutSii(rut) || null : null,
    periodo: periodoCand && esPeriodo(periodoCand) ? periodoCand : null,
  };
}
