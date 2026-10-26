import type { NextFunction, Request, Response } from "express";
import { z, ZodError } from "zod";
import { config } from "../config";
import { CertificadoInvalidoError } from "../core/certificado";
import { secretoIgual } from "../core/credenciales";
import { ErrorHttp } from "../errores";
import { log } from "../log";
import { ErrorSii } from "../sii/cliente";
import { autenticar, type Actor } from "../workers/consumidores";

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
  }
}

function bearer(req: Request): string | null {
  const h = req.header("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/** API de administración: alta de consumidores y keys. Token fijo del entorno. */
export function soloAdmin(req: Request, _res: Response, next: NextFunction): void {
  const t = bearer(req);
  if (!t || !secretoIgual(t, config().ADMIN_TOKEN)) throw new ErrorHttp(401, "NO_AUTORIZADO", "Token de administración inválido.");
  next();
}

/** API de consumidores: `Authorization: Bearer rk_…`. */
export async function conApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const t = bearer(req);
  const actor = t ? await autenticar(t) : null;
  if (!actor) throw new ErrorHttp(401, "NO_AUTORIZADO", "API key inválida, revocada o de un consumidor inactivo.");
  req.actor = actor;
  next();
}

/** Email Worker: `x-intercambio-secret`. Sin secreto configurado, la entrada está apagada. */
export function conSecretoIntercambio(req: Request, _res: Response, next: NextFunction): void {
  const esperado = config().INTERCAMBIO_SECRET;
  if (!esperado) throw new ErrorHttp(404, "INTERCAMBIO_APAGADO", "La entrada de correos no está configurada (INTERCAMBIO_SECRET).");
  const t = req.header("x-intercambio-secret") ?? "";
  if (!secretoIgual(t, esperado)) throw new ErrorHttp(401, "NO_AUTORIZADO", "Secreto de intercambio inválido.");
  next();
}

export const actorDe = (req: Request): Actor => {
  if (!req.actor) throw new ErrorHttp(401, "NO_AUTORIZADO", "Sin autenticar.");
  return req.actor;
};

export function validar<T extends z.ZodType>(esquema: T, datos: unknown): z.infer<T> {
  return esquema.parse(datos);
}

/** Traduce cualquier error a `{ error: { codigo, mensaje, detalles? } }` con el status que corresponde. */
export function manejarErrores(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let codigo = "ERROR_INTERNO";
  let mensaje = "Error interno.";
  let detalles: unknown;
  if (err instanceof ErrorHttp) {
    ({ status, codigo, message: mensaje, detalles } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    codigo = "VALIDACION";
    mensaje = "Datos inválidos.";
    detalles = err.issues.map((i) => ({ campo: i.path.join("."), mensaje: i.message }));
  } else if (err instanceof ErrorSii) {
    // El SII no contestó o contestó un error: 502 siempre; `codigo` dice cuál y `transitorio` si reintentar.
    status = 502;
    detalles = { transitorio: err.transitorio };
    codigo = err.codigo;
    mensaje = err.message;
  } else if (err instanceof CertificadoInvalidoError) {
    status = 400;
    codigo = err.codigo;
    mensaje = err.message;
  } else if ((err as { type?: string })?.type === "entity.too.large") {
    status = 413;
    codigo = "DEMASIADO_GRANDE";
    mensaje = "El cuerpo supera el tamaño permitido.";
  } else if ((err as { type?: string })?.type === "entity.parse.failed") {
    status = 400;
    codigo = "JSON_INVALIDO";
    mensaje = "El cuerpo no es JSON válido.";
  } else {
    log.error("error no controlado", { ruta: req.originalUrl, metodo: req.method, error: err, stack: (err as Error)?.stack });
  }
  res.status(status).json({ error: { codigo, mensaje, ...(detalles !== undefined ? { detalles } : {}) } });
}
