/**
 * Rotación de la llave maestra: re-sella con la llave ACTUAL (la primera de SELLO_LLAVES) todo lo
 * que esté sellado con otra. Pasos:
 *   1. SELLO_LLAVES="2:NUEVA,1:VIEJA" y reiniciar el servicio (ya sella con la 2 y abre ambas).
 *   2. npm run resellar
 *   3. Cuando diga 0 pendientes, quitar la 1 de SELLO_LLAVES.
 */
import { config } from "../src/config";
import { abrir, sellar, selladoConOtraLlave } from "../src/core/sello";
import { prisma } from "../src/db";

const { llavero } = config();
let n = 0;
for (const c of await prisma.certificado.findMany({ select: { id: true, contribuyenteId: true, llaveSellada: true } })) {
  if (!selladoConOtraLlave(c.llaveSellada, llavero)) continue;
  const aad = `certificado:${c.contribuyenteId}`;
  await prisma.certificado.update({ where: { id: c.id }, data: { llaveSellada: new Uint8Array(sellar(abrir(c.llaveSellada, aad, llavero), aad, llavero)) } });
  n++;
}
for (const c of await prisma.consumidor.findMany({ where: { webhookSecretoSellado: { not: null } }, select: { id: true, webhookSecretoSellado: true } })) {
  if (!selladoConOtraLlave(c.webhookSecretoSellado!, llavero)) continue;
  const aad = `webhook:${c.id}`;
  await prisma.consumidor.update({ where: { id: c.id }, data: { webhookSecretoSellado: new Uint8Array(sellar(abrir(c.webhookSecretoSellado!, aad, llavero), aad, llavero)) } });
  n++;
}
console.log(`Re-sellados: ${n}. Con la llave actual (${llavero.actual}) ya está todo; puedes quitar las anteriores.`);
await prisma.$disconnect();
