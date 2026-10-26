import { prisma } from "../db";
import type { Prisma } from "../generated/prisma/client";

/** Deja rastro de un cambio de configuración o credenciales. Nunca guarda secretos en `detalle`. */
export async function auditar(
  actor: { consumidorId: string | null; apiKeyId: string | null },
  accion: string,
  detalle?: Record<string, unknown>,
  contribuyenteId?: string,
): Promise<void> {
  await prisma.auditoria.create({
    data: {
      consumidorId: actor.consumidorId,
      apiKeyId: actor.apiKeyId,
      contribuyenteId: contribuyenteId ?? null,
      accion,
      detalle: (detalle ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
