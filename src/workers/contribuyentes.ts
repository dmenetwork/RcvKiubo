import { rutSii } from "../core/rut";
import { prisma } from "../db";
import { ErrorHttp, noEncontrado } from "../errores";
import type { Ambiente, Contribuyente } from "../generated/prisma/client";
import { auditar } from "./auditoria";
import type { Actor } from "./consumidores";

/** El contribuyente SÓLO si es del consumidor que pregunta. Toda ruta con `:id` pasa por acá. */
export async function contribuyenteDe(actor: Actor, id: string): Promise<Contribuyente> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw noEncontrado("El contribuyente");
  const c = await prisma.contribuyente.findFirst({ where: { id, consumidorId: actor.consumidorId } });
  if (!c) throw noEncontrado("El contribuyente");
  return c;
}

function rutValido(rut: string): string {
  const r = rutSii(rut);
  if (!r) throw new ErrorHttp(400, "RUT_INVALIDO", `El RUT ${rut} no es válido (revisa el dígito verificador).`);
  return r;
}

export interface DatosContribuyente {
  rut: string;
  razonSocial?: string | null;
  ambiente: Ambiente;
  horasAvisoPlazo?: number;
  sincronizarSii?: boolean;
  sincronizarRcv?: boolean;
}

export async function crearContribuyente(actor: Actor, d: DatosContribuyente) {
  const rut = rutValido(d.rut);
  try {
    const c = await prisma.contribuyente.create({
      data: {
        consumidorId: actor.consumidorId,
        rut,
        razonSocial: d.razonSocial ?? null,
        ambiente: d.ambiente,
        horasAvisoPlazo: d.horasAvisoPlazo ?? 48,
        sincronizarSii: d.sincronizarSii ?? true,
        sincronizarRcv: d.sincronizarRcv ?? true,
      },
    });
    await auditar(actor, "contribuyente.creado", { rut, ambiente: d.ambiente }, c.id);
    return c;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      throw new ErrorHttp(409, "CONTRIBUYENTE_DUPLICADO", "Ya existe ese RUT en ese ambiente.");
    }
    throw e;
  }
}

export async function actualizarContribuyente(actor: Actor, id: string, d: Partial<Omit<DatosContribuyente, "rut" | "ambiente">> & { activo?: boolean }) {
  const antes = await contribuyenteDe(actor, id);
  const c = await prisma.contribuyente.update({
    where: { id },
    data: {
      ...(d.razonSocial !== undefined ? { razonSocial: d.razonSocial } : {}),
      ...(d.horasAvisoPlazo !== undefined ? { horasAvisoPlazo: d.horasAvisoPlazo } : {}),
      ...(d.sincronizarSii !== undefined ? { sincronizarSii: d.sincronizarSii } : {}),
      ...(d.sincronizarRcv !== undefined ? { sincronizarRcv: d.sincronizarRcv } : {}),
      ...(d.activo !== undefined ? { activo: d.activo } : {}),
    },
  });
  await auditar(actor, "contribuyente.actualizado", d as Record<string, unknown>, id);
  // Volver a prender el seguimiento retoma lo que quedó a medias mientras estuvo apagado.
  if ((c.sincronizarSii && !antes.sincronizarSii) || (c.activo && !antes.activo)) await reprogramarSeguimiento(c.id);
  return c;
}

/**
 * Asigna (o quita, con `null`) la casilla de intercambio. Es del OPERADOR, no del consumidor: quien
 * tiene la casilla recibe las facturas, y la regla del Email Routing de Cloudflare también la
 * configura el operador. Dos contribuyentes no comparten casilla.
 */
export async function asignarCasilla(contribuyenteId: string, correo: string | null) {
  const limpio = correo?.trim().toLowerCase() || null;
  try {
    const c = await prisma.contribuyente.update({ where: { id: contribuyenteId }, data: { correoIntercambio: limpio } });
    await auditar({ consumidorId: c.consumidorId, apiKeyId: null }, "contribuyente.casilla", { correo: limpio }, c.id);
    return c;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P2002") throw new ErrorHttp(409, "CASILLA_DUPLICADA", "Esa casilla ya está asignada a otro contribuyente.");
    if (code === "P2025") throw noEncontrado("El contribuyente");
    throw e;
  }
}

/**
 * Vuelve a poner en la cola del job los documentos cuyo seguimiento quedó detenido (por errores, o
 * porque no había certificado o el seguimiento estaba apagado). El job recalcula y suelta los que ya
 * no tengan nada pendiente con el SII.
 */
export async function reprogramarSeguimiento(contribuyenteId: string, ahora = new Date()): Promise<number> {
  const r = await prisma.documento.updateMany({
    where: {
      contribuyenteId,
      proximaRevisionEn: null,
      creadoEn: { gt: new Date(ahora.getTime() - 60 * 86_400_000) },
      OR: [
        { tipoDte: { in: [33, 34, 43] }, fechaRecepcionSii: null },
        { tipoDte: { in: [33, 34, 43] }, eventoReceptor: null, plazoVence: { gt: ahora } },
        { operacion: "COMPRA", estadoSii: null },
      ],
    },
    data: { proximaRevisionEn: ahora, erroresRevision: 0, errorRevision: null },
  });
  return r.count;
}

export async function listarContribuyentes(actor: Actor) {
  return prisma.contribuyente.findMany({
    where: { consumidorId: actor.consumidorId },
    orderBy: { creadoEn: "asc" },
    include: { certificado: { select: { rutTitular: true, nombreTitular: true, validoHasta: true } } },
  });
}
