import { Router } from "express";
import { z } from "zod";
import { soloAdmin, validar } from "../middlewares";
import { actualizarConsumidor, crearApiKey, crearConsumidor, listarConsumidores, revocarApiKey } from "../../workers/consumidores";
import { asignarCasilla } from "../../workers/contribuyentes";
import { correosParaRevisar, reprocesarCorreo } from "../../workers/intercambio";

/** Administración del servicio: consumidores, API keys y casillas de intercambio. Token `ADMIN_TOKEN`. */
export const admin = Router();
admin.use(soloAdmin);

const uuid = z.string().uuid();

admin.post("/consumidores", async (req, res) => {
  const { nombre } = validar(z.object({ nombre: z.string().trim().min(1).max(100) }), req.body);
  // La API key se muestra UNA vez: no hay cómo recuperarla después.
  res.status(201).json(await crearConsumidor(nombre));
});

admin.get("/consumidores", async (_req, res) => {
  res.json({ consumidores: await listarConsumidores() });
});

admin.patch("/consumidores/:id", async (req, res) => {
  const datos = validar(z.object({ nombre: z.string().trim().min(1).max(100).optional(), activo: z.boolean().optional() }), req.body);
  res.json(await actualizarConsumidor(validar(uuid, req.params.id), datos));
});

admin.post("/consumidores/:id/api-keys", async (req, res) => {
  const { nombre } = validar(z.object({ nombre: z.string().trim().min(1).max(100).default("adicional") }), req.body ?? {});
  res.status(201).json(await crearApiKey(validar(uuid, req.params.id), nombre));
});

admin.delete("/api-keys/:id", async (req, res) => {
  await revocarApiKey(validar(uuid, req.params.id));
  res.status(204).end();
});

/** La casilla la asigna el operador: quien la tiene recibe las facturas del RUT. */
admin.put("/contribuyentes/:id/casilla", async (req, res) => {
  const { correo } = validar(z.object({ correo: z.string().trim().email().nullable() }), req.body);
  const c = await asignarCasilla(validar(uuid, req.params.id), correo);
  res.json({ id: c.id, rut: c.rut, correoIntercambio: c.correoIntercambio });
});

/** Correos que no se pudieron procesar (sin destino o con error), para revisarlos o reprocesarlos. */
admin.get("/correos", async (_req, res) => {
  res.json({ correos: await correosParaRevisar() });
});

/** Reprocesa un correo guardado con su crudo (p. ej. tras asignar la casilla que faltaba). */
admin.post("/correos/:id/reprocesar", async (req, res) => {
  res.json(await reprocesarCorreo(validar(uuid, req.params.id)));
});
