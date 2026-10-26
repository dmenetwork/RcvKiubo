/**
 * Logger de una línea JSON por evento. Nunca recibe un certificado, una llave, un token ni una API
 * key: quien loguea pasa identificadores, no secretos.
 */

const NIVELES = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Nivel = keyof typeof NIVELES;

function escribir(nivel: Nivel, msg: string, campos?: Record<string, unknown>): void {
  const minimo = NIVELES[(process.env.LOG_NIVEL as Nivel) ?? "info"] ?? NIVELES.info;
  if (NIVELES[nivel] < minimo || process.env.VITEST) return;
  const linea = JSON.stringify({ t: new Date().toISOString(), nivel, msg, ...campos }, (_k, v) =>
    typeof v === "bigint" ? Number(v) : v instanceof Error ? { nombre: v.name, mensaje: v.message } : v,
  );
  (nivel === "error" || nivel === "warn" ? process.stderr : process.stdout).write(linea + "\n");
}

export const log = {
  debug: (msg: string, campos?: Record<string, unknown>) => escribir("debug", msg, campos),
  info: (msg: string, campos?: Record<string, unknown>) => escribir("info", msg, campos),
  warn: (msg: string, campos?: Record<string, unknown>) => escribir("warn", msg, campos),
  error: (msg: string, campos?: Record<string, unknown>) => escribir("error", msg, campos),
};
