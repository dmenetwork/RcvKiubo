import { isIP } from "node:net";
import { config } from "../config";
import { generarApiKey, generarSecretoWebhook, hashApiKey, pareceApiKey } from "../core/credenciales";
import { esIpProhibida, esNombreLocal, hostNormalizado } from "../core/red";
import { abrir, sellar } from "../core/sello";
import { prisma } from "../db";
import { ErrorHttp, noEncontrado } from "../errores";
import { auditar } from "./auditoria";

/** Quién está llamando: lo resuelve el middleware de auth y viaja a cada worker. */
export interface Actor {
  consumidorId: string;
  apiKeyId: string | null;
}

export async function crearConsumidor(nombre: string): Promise<{ id: string; nombre: string; apiKey: string }> {
  const k = generarApiKey();
  const c = await prisma.consumidor.create({
    data: { nombre, apiKeys: { create: { nombre: "inicial", prefijo: k.prefijo, hash: k.hash } } },
  });
  await auditar({ consumidorId: c.id, apiKeyId: null }, "consumidor.creado", { nombre });
  return { id: c.id, nombre: c.nombre, apiKey: k.clave };
}

export async function listarConsumidores() {
  return prisma.consumidor.findMany({
    orderBy: { creadoEn: "asc" },
    select: {
      id: true,
      nombre: true,
      activo: true,
      webhookUrl: true,
      creadoEn: true,
      apiKeys: { select: { id: true, nombre: true, prefijo: true, creadaEn: true, revocadaEn: true, ultimoUsoEn: true } },
      _count: { select: { contribuyentes: true } },
    },
  });
}

export async function actualizarConsumidor(id: string, datos: { activo?: boolean; nombre?: string }) {
  const c = await prisma.consumidor.update({ where: { id }, data: datos }).catch(() => null);
  if (!c) throw noEncontrado("El consumidor");
  await auditar({ consumidorId: id, apiKeyId: null }, "consumidor.actualizado", datos);
  return { id: c.id, nombre: c.nombre, activo: c.activo };
}

/** Una key nueva (para rotar sin cortar el servicio). La clave se muestra UNA vez. */
export async function crearApiKey(consumidorId: string, nombre: string): Promise<{ id: string; apiKey: string; prefijo: string }> {
  const existe = await prisma.consumidor.findUnique({ where: { id: consumidorId }, select: { id: true } });
  if (!existe) throw noEncontrado("El consumidor");
  const k = generarApiKey();
  const r = await prisma.apiKey.create({ data: { consumidorId, nombre, prefijo: k.prefijo, hash: k.hash } });
  await auditar({ consumidorId, apiKeyId: null }, "api_key.creada", { id: r.id, nombre, prefijo: k.prefijo });
  return { id: r.id, apiKey: k.clave, prefijo: k.prefijo };
}

export async function revocarApiKey(id: string): Promise<void> {
  const r = await prisma.apiKey.updateMany({ where: { id, revocadaEn: null }, data: { revocadaEn: new Date() } });
  if (r.count === 0) throw noEncontrado("La API key (o ya estaba revocada)");
  const k = await prisma.apiKey.findUnique({ where: { id }, select: { consumidorId: true } });
  await auditar({ consumidorId: k?.consumidorId ?? null, apiKeyId: null }, "api_key.revocada", { id });
}

/** `null` si la key no existe, está revocada o su consumidor está inactivo. */
export async function autenticar(clave: string, ahora = new Date()): Promise<Actor | null> {
  if (!pareceApiKey(clave)) return null;
  const k = await prisma.apiKey.findUnique({
    where: { hash: hashApiKey(clave) },
    select: { id: true, revocadaEn: true, ultimoUsoEn: true, consumidor: { select: { id: true, activo: true } } },
  });
  if (!k || k.revocadaEn || !k.consumidor.activo) return null;
  // Escribir en cada request es una escritura por llamada: basta con saberlo al minuto.
  if (!k.ultimoUsoEn || ahora.getTime() - k.ultimoUsoEn.getTime() > 60_000) {
    await prisma.apiKey.update({ where: { id: k.id }, data: { ultimoUsoEn: ahora } }).catch(() => {});
  }
  return { consumidorId: k.consumidor.id, apiKeyId: k.id };
}

// ── Webhook del consumidor ────────────────────────────────────────────────────────────────────

/**
 * Valida la URL del webhook al configurarla: https, y nada que sea a simple vista local o privado
 * (IP literal prohibida, `localhost`, `.local`, nombres sin dominio). La defensa de verdad está al
 * CONECTAR (`lookupSeguro` en `webhooks.ts`): un nombre público que resuelve a una IP privada se
 * rechaza ahí. Ésta es para avisar temprano.
 */
export function validarUrlWebhook(url: string, permitirInseguro = config().WEBHOOK_PERMITIR_INSEGURO): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ErrorHttp(400, "WEBHOOK_URL_INVALIDA", "La URL del webhook no es válida.");
  }
  if (permitirInseguro) return u.toString();
  if (u.protocol !== "https:") throw new ErrorHttp(400, "WEBHOOK_URL_INVALIDA", "El webhook debe ser https.");
  if (u.username || u.password) throw new ErrorHttp(400, "WEBHOOK_URL_INVALIDA", "El webhook no puede llevar usuario ni clave en la URL.");
  const h = hostNormalizado(u);
  if ((isIP(h) && esIpProhibida(h)) || (!isIP(h) && esNombreLocal(h))) {
    throw new ErrorHttp(400, "WEBHOOK_URL_INVALIDA", "El webhook no puede apuntar a una red local o privada.");
  }
  return u.toString();
}

/** Fija (o cambia) la URL. Genera secreto la primera vez o si se pide rotarlo; devuelve el secreto SÓLO entonces. */
export async function configurarWebhook(actor: Actor, url: string, rotarSecreto = false): Promise<{ url: string; secreto: string | null }> {
  const limpia = validarUrlWebhook(url);
  const c = await prisma.consumidor.findUniqueOrThrow({ where: { id: actor.consumidorId }, select: { webhookSecretoSellado: true } });
  let secreto: string | null = null;
  const data: { webhookUrl: string; webhookSecretoSellado?: Uint8Array<ArrayBuffer> } = { webhookUrl: limpia };
  if (!c.webhookSecretoSellado || rotarSecreto) {
    secreto = generarSecretoWebhook();
    data.webhookSecretoSellado = new Uint8Array(sellar(secreto, `webhook:${actor.consumidorId}`, config().llavero));
  }
  await prisma.consumidor.update({ where: { id: actor.consumidorId }, data });
  await auditar(actor, "webhook.configurado", { url: limpia, secretoRotado: secreto !== null });
  return { url: limpia, secreto };
}

export async function quitarWebhook(actor: Actor): Promise<void> {
  await prisma.consumidor.update({ where: { id: actor.consumidorId }, data: { webhookUrl: null, webhookSecretoSellado: null } });
  await auditar(actor, "webhook.quitado");
}

export function abrirSecretoWebhook(consumidorId: string, sellado: Uint8Array): string {
  return abrir(sellado, `webhook:${consumidorId}`, config().llavero).toString("utf8");
}
