/** Tasa del IVA vigente (Art. 14 DL 825). */
const IVA_RATE = 19;

/**
 * Códigos de `<ImptoReten>` según la tabla §4 de `docs/formato_dte_pdf.md` (pág. 51-54), y cómo entran al
 * `<MntTotal>` (campo 124, `docs/formato_dte_pdf.md:513`). Una sola fuente para emitir y para revisar lo recibido
 * (R25 de docs/PLAN-MIGRACION-CHONCHI.md): con una lista por lado, la próxima corrección se hacía en una y la otra
 * aceptaba o rechazaba mal un documento.
 *
 * - ADICIONALES suman al total: IVA margen de comercialización (14), IVA anticipado (17-19),
 *   impuestos adicionales Art. 37 (23, 44, 45), ILA Art. 42 (24-27, 271), específicos de
 *   combustibles (28, 35, 51, 52) e IVA de instrumentos de prepago (50).
 * - RETENCIONES restan: IVA retenido total y parcial (15, 30-34, 36-39, 41, 46-49), sus códigos de
 *   cambio de sujeto (301…481) y la retención a suplementeros (53). El 46 es IVA retenido oro, en
 *   facturas 33: el comprador retiene el IVA y el total baja. La factura de compra (46) retiene con los
 *   códigos de `TASAS_RETENCION_COMPRA` (15 = retención total).
 *
 * Un código fuera de las dos listas NO se adivina: el total no se puede cuadrar y es problema.
 */
export const IMPUESTOS_ADICIONALES: ReadonlySet<number> = new Set([
  14, 17, 18, 19, 23, 24, 25, 26, 27, 271, 28, 35, 44, 45, 50, 51, 52,
]);
export const RETENCIONES: ReadonlySet<number> = new Set([
  15, 30, 31, 32, 33, 34, 36, 37, 38, 39, 41, 46, 47, 48, 49, 53, 301, 321, 331, 341, 361, 371, 481,
]);

/**
 * Retenciones que admite la FACTURA DE COMPRA 46 (R21, D4 de docs/PLAN-MIGRACION-CHONCHI.md), con la tasa
 * (% sobre el neto de las líneas que la citan) transcrita de la tabla §4 (`docs/formato_dte_pdf.md:794-841`).
 * Son los códigos cuya columna "Documentos en que se aplica" nombra la "Factura de Compra emitida cod (45, 46)":
 *
 * - Retención TOTAL del IVA (tasa del IVA): 15 IVA retenido total, 31 silvestres, 38 chatarra, 39 PPA,
 *   41 construcción, 47 cartones.
 * - Retención PARCIAL ("Normalmente X% retención"): 30 legumbres 10, 32 ganado 8, 33 madera 8, 34 trigo 4,
 *   36 arroz 10, 37 hidrobiológicas 10, 48 frambuesas 14.
 *
 * Fuera, a propósito: 46 (oro) aplica a facturas 30/33, no a la de compra; 49 (sin retención) solo la usa la
 * Bolsa de Productos y el SII lo valida; y los códigos de la columna "cambio de sujeto en retención total"
 * (301…481), que son la variante de retención TOTAL de cada parcial para agentes retenedores: entran si el
 * contador los pide (`docs/CONFIRMACIONES-CLIENTE.md`, factura de compra #2). Un código sin tasa en la
 * tabla no se emite (D4). La retención total usa la tasa del IVA vigente (`IVA_RATE`).
 */
export const TASAS_RETENCION_COMPRA: ReadonlyMap<number, number> = new Map([
  [15, IVA_RATE], [31, IVA_RATE], [38, IVA_RATE], [39, IVA_RATE], [41, IVA_RATE], [47, IVA_RATE],
  [30, 10], [32, 8], [33, 8], [34, 4], [36, 10], [37, 10], [48, 14],
]);

export interface MontoDeImpuesto {
  codigo: number;
  monto: number;
}

/**
 * Separa los impuestos de un documento según cómo entran al total. Los códigos fuera de la tabla van a
 * `desconocidos` (uno por aparición): quien llama decide si es un problema a informar o un error que corta.
 */
export function clasificarImpuestos(impuestos: readonly MontoDeImpuesto[]): {
  adicionales: number;
  retenciones: number;
  desconocidos: number[];
} {
  let adicionales = 0;
  let retenciones = 0;
  const desconocidos: number[] = [];
  for (const imp of impuestos) {
    if (IMPUESTOS_ADICIONALES.has(imp.codigo)) adicionales += imp.monto;
    else if (RETENCIONES.has(imp.codigo)) retenciones += imp.monto;
    else desconocidos.push(imp.codigo);
  }
  return { adicionales, retenciones, desconocidos };
}
