import type { EstadoRcv, FilaRcv, OperacionRcv } from "./rcv-csv";

/**
 * El RCV en el formato en que lo muestra y lo exporta el portal del SII: la tabla de resumen por tipo
 * de documento, el detalle por documento y el CSV de "Descargar detalles". Dominio puro.
 */

export interface ResumenVista {
  tipoDte: number;
  nombreTipoDoc: string;
  tieneDetalle: boolean;
  totalDocumentos: number;
  montoExento: number;
  montoNeto: number;
  montoIva: number;
  montoIvaNoRecuperable: number;
  ivaUsoComun: number;
  montoTotal: number;
}

/** Una fila del detalle: lo que dijo el SII (`FilaRcv`) + lo que agrega RcvKiubo. */
export interface DetalleVista extends Omit<FilaRcv, "linea" | "extra" | "otrosImpuestos"> {
  otrosImpuestos: number | null;
  /** La leyenda del evento del receptor que muestra el SII ("Recibo otorgado por el receptor"). */
  evento: string | null;
  /** ¿Llegó el XML por el buzón? Sólo compras: lo que el SII no muestra. */
  enXml: boolean | null;
}

/** De lo guardado en `datosRcv` (una `FilaRcv`) a una fila de la vista. */
export function detalleDesdeFila(f: FilaRcv, enXml: boolean | null): DetalleVista {
  const { linea: _l, extra, otrosImpuestos, ...resto } = f;
  const otros = Number(extra?.totalDtoiMontoImp ?? NaN);
  const sumaCsv = otrosImpuestos?.reduce((s, o) => s + (o.valor ?? 0), 0) ?? 0;
  return {
    ...resto,
    otrosImpuestos: Number.isFinite(otros) ? otros : sumaCsv || null,
    evento: extra?.detEventoReceptorLeyenda ?? null,
    enXml,
  };
}

const NOMBRES: Record<number, string> = {
  33: "Factura Electrónica",
  34: "Factura no Afecta o Exenta Electrónica",
  39: "Boleta Electrónica",
  43: "Liquidación Factura Electrónica",
  46: "Factura de Compra Electrónica",
  52: "Guía de Despacho Electrónica",
  56: "Nota de Débito Electrónica",
  61: "Nota de Crédito Electrónica",
};
export const nombreTipo = (t: number) => NOMBRES[t] ?? `Tipo ${t}`;

/** `1234567` → `1.234.567` (miles con punto, como el SII). */
export function clp(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return (n < 0 ? "-" : "") + Math.abs(Math.trunc(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** `76086428-5` → `76.086.428-5`. */
export function rutConPuntos(rut: string): string {
  const [c, dv] = rut.split("-");
  return `${(c ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv ?? ""}`;
}

/** `AAAA-MM-DD…` o ISO con offset → `DD/MM/AAAA[ HH:MM:SS]` en la hora que trae el texto (Chile). */
export function fechaSii(v: string | null | undefined, conHora = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(v ?? "");
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}` + (conHora && m[4] ? ` ${m[4]}:${m[5]}:${m[6]}` : "");
}

// ── CSV ───────────────────────────────────────────────────────────────────────────────────────

const ENC_COMPRA = [
  "Nro", "Tipo Doc", "Tipo Compra", "RUT Proveedor", "Razon Social", "Folio", "Fecha Docto", "Fecha Recepcion",
  "Fecha Acuse", "Monto Exento", "Monto Neto", "Monto IVA Recuperable", "Monto Iva No Recuperable",
  "Codigo IVA No Rec.", "Monto Total", "Valor Otro Impuesto",
];
const ENC_VENTA = [
  "Nro", "Tipo Doc", "Tipo Venta", "Rut cliente", "Razon Social", "Folio", "Fecha Docto", "Fecha Recepcion",
  "Fecha Acuse Recibo", "Fecha Reclamo", "Monto Exento", "Monto Neto", "Monto IVA", "Monto total",
];

const celda = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** El CSV como lo descarga el portal: `;`, montos sin separador de miles, fechas `DD/MM/AAAA`. */
export function csvRcv(operacion: OperacionRcv, filas: DetalleVista[]): string {
  const lineas = [(operacion === "COMPRA" ? ENC_COMPRA : ENC_VENTA).join(";")];
  filas.forEach((f, i) => {
    const comun = [i + 1, f.tipoDte, f.tipoTransaccion ?? "", f.rutContraparte, f.razonSocial ?? "", f.folio, fechaSii(f.fechaEmision), fechaSii(f.fechaRecepcionSii, true)];
    lineas.push(
      (operacion === "COMPRA"
        ? [...comun, fechaSii(f.fechaAcuse, true), f.montoExento, f.montoNeto, f.montoIva, f.montoIvaNoRecuperable, f.codigoIvaNoRecuperable, f.montoTotal, f.otrosImpuestos]
        : [...comun, fechaSii(f.fechaAcuse, true), fechaSii(f.fechaReclamo, true), f.montoExento, f.montoNeto, f.montoIva, f.montoTotal]
      )
        .map(celda)
        .join(";"),
    );
  });
  return lineas.join("\r\n") + "\r\n";
}

// ── HTML ──────────────────────────────────────────────────────────────────────────────────────

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface SeccionVista {
  operacion: OperacionRcv;
  estado: EstadoRcv | null;
  resumen: ResumenVista[];
  detalle: DetalleVista[];
}

/** Cómo entra cada tipo al total: las notas de crédito (61) restan; el resto suma. */
export const signoTipo = (tipoDte: number) => (tipoDte === 61 ? -1 : 1);

const ETIQUETA_ESTADO: Record<string, string> = {
  REGISTRO: "Registro",
  PENDIENTE: "Pendientes",
  NO_INCLUIR: "No incluir",
  RECLAMADO: "Reclamados",
};

function tablaResumen(s: SeccionVista): string {
  if (s.resumen.length === 0) return `<p class="vacio">Sin documentos.</p>`;
  const compra = s.operacion === "COMPRA";
  // Las notas de crédito RESTAN del total (montos, no documentos): sumarlas daría un IVA falso.
  const tot = s.resumen.reduce(
    (a, r) => {
      const k = signoTipo(r.tipoDte);
      return {
        d: a.d + r.totalDocumentos, e: a.e + k * r.montoExento, n: a.n + k * r.montoNeto, i: a.i + k * r.montoIva,
        nr: a.nr + k * r.montoIvaNoRecuperable, uc: a.uc + k * r.ivaUsoComun, t: a.t + k * r.montoTotal,
      };
    },
    { d: 0, e: 0, n: 0, i: 0, nr: 0, uc: 0, t: 0 },
  );
  const fila = (r: Pick<ResumenVista, "totalDocumentos" | "montoExento" | "montoNeto" | "montoIva" | "montoIvaNoRecuperable" | "ivaUsoComun" | "montoTotal">, nombre: string, cls = "") =>
    `<tr class="${cls}"><td class="txt">${esc(nombre)}</td><td>${clp(r.totalDocumentos)}</td><td>${clp(r.montoExento)}</td><td>${clp(r.montoNeto)}</td>` +
    `<td>${clp(r.montoIva)}</td>${compra ? `<td>${clp(r.ivaUsoComun)}</td><td>${clp(r.montoIvaNoRecuperable)}</td>` : ""}<td>${clp(r.montoTotal)}</td></tr>`;
  return (
    `<table><thead><tr><th class="txt">Tipo Documento</th><th>Total Documentos</th><th>Monto Exento</th><th>Monto Neto</th>` +
    `<th>${compra ? "IVA Recuperable" : "Monto IVA"}</th>${compra ? "<th>IVA Uso Común</th><th>IVA No Recuperable</th>" : ""}<th>Monto Total</th></tr></thead><tbody>` +
    s.resumen.map((r) => fila(r, `${r.nombreTipoDoc} (${r.tipoDte})${r.tieneDetalle ? "" : " — sólo total"}${signoTipo(r.tipoDte) < 0 ? " — resta" : ""}`)).join("") +
    fila({ totalDocumentos: tot.d, montoExento: tot.e, montoNeto: tot.n, montoIva: tot.i, montoIvaNoRecuperable: tot.nr, ivaUsoComun: tot.uc, montoTotal: tot.t }, "Total (las notas de crédito restan)", "total") +
    `</tbody></table>`
  );
}

function tablaDetalle(s: SeccionVista): string {
  if (s.detalle.length === 0) return "";
  const compra = s.operacion === "COMPRA";
  const porTipo = new Map<number, DetalleVista[]>();
  for (const d of s.detalle) porTipo.set(d.tipoDte, [...(porTipo.get(d.tipoDte) ?? []), d]);
  return [...porTipo]
    .sort(([a], [b]) => a - b)
    .map(([tipo, filas]) => {
      const cuerpo = filas
        .sort((a, b) => (a.fechaEmision ?? "").localeCompare(b.fechaEmision ?? "") || a.folio - b.folio)
        .map(
          (f, i) =>
            `<tr${compra && f.enXml === false ? ' class="sinxml"' : ""}><td>${i + 1}</td><td class="txt">${esc(f.tipoTransaccion)}</td>` +
            `<td class="txt">${esc(rutConPuntos(f.rutContraparte))}</td><td class="txt">${esc(f.razonSocial)}</td><td>${f.folio}</td>` +
            `<td>${fechaSii(f.fechaEmision)}</td><td>${fechaSii(f.fechaRecepcionSii, true)}</td><td>${fechaSii(f.fechaAcuse, true)}</td>` +
            (compra ? "" : `<td>${fechaSii(f.fechaReclamo, true)}</td>`) +
            `<td>${clp(f.montoExento)}</td><td>${clp(f.montoNeto)}</td><td>${clp(f.montoIva)}</td>` +
            (compra ? `<td>${clp(f.montoIvaNoRecuperable)}</td><td>${clp(f.otrosImpuestos)}</td>` : "") +
            `<td>${clp(f.montoTotal)}</td><td class="txt">${esc(f.evento)}</td>` +
            (compra ? `<td class="txt">${f.enXml === null ? "" : f.enXml ? "Sí" : "<b>No</b>"}</td>` : "") +
            `</tr>`,
        )
        .join("");
      return (
        `<details><summary>${esc(nombreTipo(tipo))} (${tipo}) — ${filas.length} documentos</summary><div class="scroll"><table class="det"><thead><tr>` +
        `<th>Nro</th><th class="txt">Tipo ${compra ? "Compra" : "Venta"}</th><th class="txt">RUT ${compra ? "Proveedor" : "Cliente"}</th><th class="txt">Razón Social</th>` +
        `<th>Folio</th><th>Fecha Docto.</th><th>Fecha Recepción</th><th>Fecha Acuse</th>${compra ? "" : "<th>Fecha Reclamo</th>"}` +
        `<th>Monto Exento</th><th>Monto Neto</th><th>${compra ? "IVA Recuperable" : "Monto IVA"}</th>` +
        `${compra ? "<th>IVA No Recuperable</th><th>Otros Impuestos</th>" : ""}<th>Monto Total</th><th class="txt">Evento receptor</th>` +
        `${compra ? '<th class="txt">XML en buzón</th>' : ""}</tr></thead><tbody>${cuerpo}</tbody></table></div></details>`
      );
    })
    .join("");
}

/** Página autocontenida con el RCV de un período, ordenada como el portal: compras por estado, luego ventas. */
export function htmlRcv(p: { rut: string; razonSocial: string | null; periodo: string; sincronizadoEn: string | null; secciones: SeccionVista[] }): string {
  const mes = `${p.periodo.slice(4)}/${p.periodo.slice(0, 4)}`;
  const secciones = p.secciones
    .map(
      (s) =>
        `<section><h2>${s.operacion === "COMPRA" ? `Compras — ${ETIQUETA_ESTADO[s.estado ?? ""] ?? s.estado}` : "Ventas"}</h2>` +
        tablaResumen(s) +
        tablaDetalle(s) +
        `</section>`,
    )
    .join("");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RCV ${esc(rutConPuntos(p.rut))} ${mes}</title><style>
:root{--fg:#1f2937;--muted:#6b7280;--line:#d1d5db;--head:#e8eef6;--accent:#1d4e89;--warn:#fff4e5;--bg:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#e5e7eb;--muted:#9ca3af;--line:#374151;--head:#1f2a37;--accent:#93c5fd;--warn:#3b2f1a;--bg:#111827}}
body{font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:16px}
header{border-bottom:3px solid var(--accent);margin-bottom:16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;color:var(--accent);margin:24px 0 8px}
.meta{color:var(--muted);margin:0 0 12px}table{border-collapse:collapse;width:100%;margin-bottom:8px}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:right;white-space:nowrap}th{background:var(--head);font-weight:600}
.txt{text-align:left}tr.total td{font-weight:700;background:var(--head)}tr.sinxml td{background:var(--warn)}
details{margin:6px 0}summary{cursor:pointer;font-weight:600;padding:4px 0}.scroll{overflow-x:auto}.vacio{color:var(--muted)}
</style></head><body><header><h1>Registro de Compras y Ventas</h1>
<p class="meta">${esc(p.razonSocial ?? "")} · RUT ${esc(rutConPuntos(p.rut))} · Período ${mes}${p.sincronizadoEn ? ` · Datos del SII al ${esc(fechaSii(p.sincronizadoEn, true))}` : ""}</p>
<p class="meta">Las filas marcadas en las compras son facturas que el SII tiene y que no llegaron por el buzón de intercambio.</p></header>
${secciones}</body></html>`;
}
