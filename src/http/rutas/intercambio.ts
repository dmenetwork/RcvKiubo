import express, { Router } from "express";
import { conSecretoIntercambio } from "../middlewares";
import { MAX_BYTES_CORREO, recibirCorreo, registrarLatido } from "../../workers/intercambio";

/**
 * Entrada del Email Worker de Cloudflare. MISMO contrato que Kiubo (`/api/intercambio/entrante`):
 * el Worker de `email-worker/` sirve para cualquiera de los dos cambiando sólo `INTERCAMBIO_URL`.
 */
export const intercambio = Router();
intercambio.use(conSecretoIntercambio);

intercambio.post(
  "/entrante",
  express.raw({ type: () => true, limit: MAX_BYTES_CORREO }),
  async (req, res) => {
    const crudo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await recibirCorreo(crudo, req.header("x-intercambio-to") ?? "");
    // 200 aunque el correo no traiga DTE o no tenga destino: reintentar no lo arregla, y el Worker
    // reintenta todo lo que no sea 2xx/400/413. Queda registrado en `correos` para revisarlo.
    res.json(r);
  },
);

intercambio.get("/latido", async (req, res) => {
  const num = (h: string) => {
    const v = req.header(h);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
  };
  await registrarLatido(num("x-intercambio-pendientes"), num("x-intercambio-mas-antiguo"));
  res.json({ ok: true });
});
