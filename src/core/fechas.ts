/**
 * Fechas en hora de Chile, como las escribe y las lee el SII.
 *
 * El SII habla en hora de Santiago (UTC-3 en verano, UTC-4 en invierno) y el contenedor corre en
 * UTC. Todo lo que cruza esa frontera pasa por acá. Dominio puro.
 */

const SANTIAGO_TZ = "America/Santiago";

const SANTIAGO_SEGUNDOS = new Intl.DateTimeFormat("en-GB", {
  timeZone: SANTIAGO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const OFFSET_SANTIAGO = new Intl.DateTimeFormat("en-US", {
  timeZone: SANTIAGO_TZ,
  timeZoneName: "longOffset",
});

function assertFecha(valor: Date, que: string): void {
  if (!(valor instanceof Date) || Number.isNaN(valor.getTime())) {
    throw new Error(`El valor de ${que} no es una fecha válida.`);
  }
}

/** `AAAA-MM-DDTHH:MM:SS` en hora de Chile, sin offset: la forma de `TmstFirma` y compañía. */
export function siiTimestamp(instante: Date): string {
  assertFecha(instante, "el instante");
  const partes = SANTIAGO_SEGUNDOS.formatToParts(instante);
  const v = (t: string): string => partes.find((p) => p.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")}T${v("hour")}:${v("minute")}:${v("second")}`;
}

/** `AAAA-MM-DD` del día calendario chileno de un instante. */
export function ymdSantiago(instante: Date): string {
  return siiTimestamp(instante).slice(0, 10);
}

/** ¿Es `AAAA-MM-DD` y además una fecha que existe? (`2026-02-30` no). */
export function esFechaYmdValida(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Minutos de diferencia de Santiago con UTC en ese instante (−180 en verano, −240 en invierno). */
function offsetSantiago(utcMs: number): number {
  const nombre = OFFSET_SANTIAGO.formatToParts(new Date(utcMs)).find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(nombre ?? "");
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

/**
 * Una hora local de Santiago → ISO 8601 con su offset de ese día (`2017-02-21T19:02:03-03:00`).
 * `null` si la fecha no existe (31-02): inventarla sería calcular un plazo falso.
 */
export function isoDesdeSantiago(
  aaaa: number,
  mm: number,
  dd: number,
  hh = 0,
  mi = 0,
  ss = 0,
): string | null {
  const local = Date.UTC(aaaa, mm - 1, dd, hh, mi, ss);
  const d = new Date(local);
  // Date.UTC "corrige" un 31-02 al 03-03: si no vuelve igual, la fecha no existía.
  if (d.getUTCDate() !== dd || d.getUTCMonth() !== mm - 1 || d.getUTCHours() !== hh) return null;
  // El offset depende del instante, que depende del offset: dos pasadas resuelven el cambio de hora.
  let offset = offsetSantiago(local);
  offset = offsetSantiago(local - offset * 60_000);
  const signo = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${aaaa}-${p2(mm)}-${p2(dd)}T${p2(hh)}:${p2(mi)}:${p2(ss)}` +
    `${signo}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`
  );
}

/**
 * Lee las fechas en el formato chileno que usa el SII en portal, CSV y web services:
 * `dd-mm-aaaa`, `dd/mm/aaaa`, opcionalmente con ` hh:mm[:ss]`; y también `aaaa-mm-dd[ hh:mm:ss]`.
 * Devuelve ISO con el offset de Santiago, o `null` si no es una fecha válida.
 */
export function parsearFechaChilena(valor: string | null | undefined): string | null {
  const v = (valor ?? "").trim();
  let m = /^(\d{2})[-/](\d{2})[-/](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) return isoDesdeSantiago(+m[3]!, +m[2]!, +m[1]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (m) return isoDesdeSantiago(+m[1]!, +m[2]!, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return null;
}

/** Período tributario `AAAAMM`. */
export function esPeriodo(v: string): boolean {
  const m = /^(\d{4})(\d{2})$/.exec(v);
  return !!m && +m[2]! >= 1 && +m[2]! <= 12 && +m[1]! >= 2000;
}

/** Período tributario (`AAAAMM`) de una fecha `AAAA-MM-DD…`. */
export function periodoDe(fechaYmd: string): string {
  return fechaYmd.slice(0, 4) + fechaYmd.slice(5, 7);
}
