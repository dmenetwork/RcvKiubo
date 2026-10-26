import { RECLAMOS, TIPOS_REGISTRO_RECLAMO, type AccionReclamo } from "./registro-reclamo";

/**
 * El plazo de la Ley 19.983 (modificada por la Ley 20.956) para aceptar o reclamar una factura.
 *
 * Manual del WS de registro, `ingresarAceptacionReclamoDoc`: los eventos se pueden registrar
 * "dentro de los primeros 8 días corridos (contadas desde la fecha‐hora de recepción del documento
 * en el SII … hasta la fecha‐hora actual)". Pasado eso, "se presumirá recibida la mercadería" si no
 * hubo reclamo: es la aceptación tácita, y el SII ya no admite eventos (código 8).
 *
 * El reloj es la recepción EN EL SII, no la emisión ni la llegada del correo. Sin esa fecha sólo hay
 * una cota: como la recepción es posterior a la emisión, el plazo vence DESPUÉS de emisión + 8 días.
 * Esa cota sirve para no avisar tarde, nunca para dar el plazo por vencido.
 *
 * Dominio puro.
 */

export const DIAS_PLAZO = 8;
const DIA_MS = 24 * 60 * 60 * 1000;

export type EstadoPlazo =
  /** El documento no es de los tipos con registro (33, 34, 43): no hay plazo que vigilar. */
  | "no_aplica"
  /** Ya tiene un reclamo registrado (RCD, RFP, RFT). */
  | "reclamado"
  /** Ya tiene aceptación (ACD) o recibo de mercaderías (ERM). */
  | "aceptado"
  /** Dentro del plazo y sin evento. */
  | "vigente"
  /** Dentro del plazo, sin evento, y le quedan menos de `horasAviso`. */
  | "por_vencer"
  /** Pasó el plazo sin reclamo: aceptado tácitamente; el SII ya no admite eventos. */
  | "aceptado_tacito"
  /** No se sabe la fecha de recepción en el SII: hay que consultarla. */
  | "sin_fecha";

export interface SituacionPlazo {
  estado: EstadoPlazo;
  /** Vencimiento exacto (ISO), o `null` sin fecha de recepción. */
  vence: string | null;
  /** Cota inferior del vencimiento a partir de la emisión, cuando no hay recepción. */
  venceNoAntesDe: string | null;
  /** Horas que quedan (redondeo hacia abajo), o `null`. Negativo si venció. */
  horasRestantes: number | null;
}

export function vencimientoPlazo(fechaRecepcionSii: string | Date): Date {
  const d = new Date(fechaRecepcionSii);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha de recepción inválida: ${String(fechaRecepcionSii)}`);
  return new Date(d.getTime() + DIAS_PLAZO * DIA_MS);
}

/**
 * Marcadores de evento que vienen del CSV del RCV, que dice QUE hubo reclamo o acuse pero no cuál de
 * los cinco códigos. El historial del SII los reemplaza por el código exacto cuando se consulta.
 */
export const EVENTO_RCV_RECLAMADO = "RECLAMADO";
export const EVENTO_RCV_ACUSE = "ACUSE";

export function situacionPlazo(opts: {
  tipoDte: number;
  fechaRecepcionSii: string | Date | null;
  /** `AAAA-MM-DD`, para la cota cuando falta la recepción. */
  fechaEmision?: string | null;
  evento: AccionReclamo | string | null;
  ahora: Date;
  horasAviso?: number;
}): SituacionPlazo {
  const sinFechas = { vence: null, venceNoAntesDe: null, horasRestantes: null };
  if (!TIPOS_REGISTRO_RECLAMO.has(opts.tipoDte)) return { estado: "no_aplica", ...sinFechas };
  if (opts.evento && (RECLAMOS.has(opts.evento) || opts.evento === EVENTO_RCV_RECLAMADO)) return { estado: "reclamado", ...sinFechas };
  if (opts.evento === "ACD" || opts.evento === "ERM" || opts.evento === EVENTO_RCV_ACUSE) return { estado: "aceptado", ...sinFechas };

  if (!opts.fechaRecepcionSii) {
    // La emisión es en hora de Chile; medianoche UTC de ese día es una cota todavía más temprana, que
    // es la dirección segura para una cota inferior.
    const cota =
      opts.fechaEmision && /^\d{4}-\d{2}-\d{2}$/.test(opts.fechaEmision)
        ? new Date(new Date(`${opts.fechaEmision}T00:00:00Z`).getTime() + DIAS_PLAZO * DIA_MS).toISOString()
        : null;
    return { estado: "sin_fecha", vence: null, venceNoAntesDe: cota, horasRestantes: null };
  }

  const vence = vencimientoPlazo(opts.fechaRecepcionSii);
  const restanteMs = vence.getTime() - opts.ahora.getTime();
  const horasRestantes = Math.floor(restanteMs / 3_600_000);
  const base = { vence: vence.toISOString(), venceNoAntesDe: null, horasRestantes };
  if (restanteMs <= 0) return { estado: "aceptado_tacito", ...base };
  if (restanteMs <= (opts.horasAviso ?? 48) * 3_600_000) return { estado: "por_vencer", ...base };
  return { estado: "vigente", ...base };
}
