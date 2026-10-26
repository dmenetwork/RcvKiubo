import { config } from "../config";
import { CertificadoInvalidoError, firmanteDesde, leerPfx } from "../core/certificado";
import type { CertificadoFirmante } from "../core/dte-firma";
import { rutSii } from "../core/rut";
import { abrir, sellar } from "../core/sello";
import { prisma } from "../db";
import { ErrorHttp } from "../errores";
import type { Contribuyente } from "../generated/prisma/client";
import type { ContextoSii } from "../sii/cliente";
import { auditar } from "./auditoria";
import type { Actor } from "./consumidores";
import { contribuyenteDe, reprogramarSeguimiento } from "./contribuyentes";
import { clienteSii } from "./sii";

/** Días de anticipación con que se avisa un vencimiento: renovar un certificado no es inmediato. */
export const DIAS_AVISO_CERTIFICADO = 30;

const aad = (contribuyenteId: string) => `certificado:${contribuyenteId}`;

/**
 * Carga (o rota) el certificado del contribuyente. Valida ANTES de guardar: que abra, que la llave
 * firme, que no esté vencido y que traiga un RUT de titular válido. La clave del .pfx no se guarda:
 * se sella la llave privada ya abierta.
 */
export async function cargarCertificado(
  actor: Actor,
  contribuyenteId: string,
  pfx: Buffer,
  clave: string,
  opts: { rutTitular?: string; ahora?: Date } = {},
) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  const ahora = opts.ahora ?? new Date();
  let leido;
  try {
    leido = leerPfx(pfx, clave);
  } catch (e) {
    if (e instanceof CertificadoInvalidoError) throw new ErrorHttp(400, e.codigo, e.message);
    throw e;
  }
  if (leido.validoHasta.getTime() < ahora.getTime()) {
    throw new ErrorHttp(422, "CERTIFICADO_VENCIDO", `El certificado venció el ${leido.validoHasta.toISOString().slice(0, 10)}.`);
  }
  // El RUT del PROPIO certificado manda; el tipeado es sólo para certificados que no lo traen.
  const rutTitular = leido.rutTitular ?? rutSii(opts.rutTitular ?? "");
  if (!rutTitular) {
    throw new ErrorHttp(400, "CERTIFICADO_SIN_RUT", "El certificado no trae el RUT del titular: indícalo en `rutTitular`, con su dígito verificador.");
  }

  const llaveSellada = new Uint8Array(sellar(leido.firmante.llavePrivadaPem, aad(c.id), config().llavero));
  const datos = {
    rutTitular,
    nombreTitular: leido.nombreTitular,
    emisor: leido.emisor,
    validoDesde: leido.validoDesde,
    validoHasta: leido.validoHasta,
    huella: leido.huella,
    x509: leido.firmante.x509,
    llaveSellada,
    avisoVencimientoEn: null,
  };
  const anterior = await prisma.certificado.findUnique({ where: { contribuyenteId: c.id }, select: { huella: true } });
  await prisma.certificado.upsert({ where: { contribuyenteId: c.id }, create: { contribuyenteId: c.id, ...datos }, update: datos });
  // El token vigente se emitió contra el certificado anterior.
  clienteSii().invalidarToken(c.id);
  await auditar(actor, anterior ? "certificado.rotado" : "certificado.cargado", { huella: leido.huella, anterior: anterior?.huella ?? null, rutTitular }, c.id);
  // Con certificado nuevo (o el primero), lo que quedó sin seguir vuelve a la cola: un certificado
  // vencido detiene el seguimiento, y renovarlo tiene que retomarlo solo.
  await reprogramarSeguimiento(c.id, ahora);
  return resumenCertificado({ ...datos, creadoEn: ahora }, ahora);
}

export function resumenCertificado(
  cert: { rutTitular: string; nombreTitular: string; emisor: string; validoDesde: Date; validoHasta: Date; huella: string; creadoEn: Date },
  ahora = new Date(),
) {
  return {
    rutTitular: cert.rutTitular,
    nombreTitular: cert.nombreTitular,
    emisor: cert.emisor,
    validoDesde: cert.validoDesde.toISOString(),
    validoHasta: cert.validoHasta.toISOString(),
    diasParaVencer: Math.floor((cert.validoHasta.getTime() - ahora.getTime()) / 86_400_000),
    huella: cert.huella,
    cargadoEn: cert.creadoEn.toISOString(),
  };
}

export async function quitarCertificado(actor: Actor, contribuyenteId: string): Promise<void> {
  const c = await contribuyenteDe(actor, contribuyenteId);
  await prisma.certificado.deleteMany({ where: { contribuyenteId: c.id } });
  clienteSii().invalidarToken(c.id);
  await auditar(actor, "certificado.quitado", {}, c.id);
}

/** El firmante del contribuyente, des-sellado en memoria. Lanza 409 si no tiene certificado. */
export async function firmanteDe(contribuyenteId: string): Promise<CertificadoFirmante & { rutTitular: string }> {
  const cert = await prisma.certificado.findUnique({ where: { contribuyenteId } });
  if (!cert) throw new ErrorHttp(409, "SIN_CERTIFICADO", "El contribuyente no tiene certificado digital cargado.");
  const llave = abrir(cert.llaveSellada, aad(contribuyenteId), config().llavero).toString("utf8");
  return { ...firmanteDesde(llave, cert.x509), rutTitular: cert.rutTitular };
}

/** El contexto con que se habla con el SII por este contribuyente. El certificado se abre sólo si hace falta. */
export function contextoSii(c: Pick<Contribuyente, "id" | "ambiente">): ContextoSii {
  return { clave: c.id, ambiente: c.ambiente, certificado: () => firmanteDe(c.id) };
}

export async function tieneCertificado(contribuyenteId: string): Promise<boolean> {
  return (await prisma.certificado.count({ where: { contribuyenteId } })) > 0;
}
