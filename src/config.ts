import "dotenv/config";
import { z } from "zod";
import { leerLlavero, type Llavero } from "./core/sello";

/**
 * Configuración por entorno, validada al arrancar: una variable mal puesta tiene que tumbar el
 * proceso en el deploy, no aparecer como un 500 la primera vez que alguien sube un certificado.
 */

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

/** `VAR=` (vacía en el .env) cuenta como no definida: así lo documenta `.env.example`. */
const opcional = <T extends z.ZodType>(t: T) => z.preprocess((v) => (v === "" ? undefined : v), t.optional());

const esquema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),
  /** Llaves maestras para sellar secretos: `"<id>:<base64 32B>[,<id>:<base64>]"`, la primera es la actual. */
  SELLO_LLAVES: z.string().min(1, "SELLO_LLAVES es obligatoria (openssl rand -base64 32)"),
  /** Token de la API de administración (alta de consumidores y API keys). */
  ADMIN_TOKEN: z.string().min(32, "ADMIN_TOKEN debe tener al menos 32 caracteres"),
  /** Secreto compartido con el Email Worker. Sin él, la entrada de correos queda apagada. */
  INTERCAMBIO_SECRET: opcional(z.string().min(32, "INTERCAMBIO_SECRET debe tener al menos 32 caracteres")),
  /** Llaves públicas del SII que firman la FRMA de los CAF (PEM; `\n` literal permitido). */
  SII_LLAVE_IDK_100: opcional(z.string()),
  SII_LLAVE_IDK_300: opcional(z.string()),
  SII_CONCURRENCIA: z.coerce.number().int().min(1).max(16).default(4),
  SII_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  /** Apagar en un proceso que sólo atiende HTTP si los jobs corren en otro. */
  JOBS_ACTIVOS: bool.default(true),
  /** Sólo desarrollo: permite webhooks a http:// y a hosts locales. */
  WEBHOOK_PERMITIR_INSEGURO: bool.default(false),
  /** Saltos de proxy de confianza (para la IP real en el rate limit). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_NIVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof esquema> & {
  llavero: Llavero;
  llavesSii: Record<string, string | null>;
};

let cache: Config | null = null;

const pem = (v: string | undefined) => (v ? v.replace(/\\n/g, "\n") : null);

export function config(): Config {
  if (cache) return cache;
  const r = esquema.safeParse(process.env);
  if (!r.success) {
    const detalle = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuración inválida: ${detalle}`);
  }
  cache = {
    ...r.data,
    llavero: leerLlavero(r.data.SELLO_LLAVES),
    llavesSii: { "100": pem(r.data.SII_LLAVE_IDK_100), "300": pem(r.data.SII_LLAVE_IDK_300) },
  };
  return cache;
}

/** Sólo tests. */
export function reiniciarConfig(): void {
  cache = null;
}
