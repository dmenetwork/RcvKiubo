import express, { type Express } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import { config } from "../config";
import { prisma } from "../db";
import { manejarErrores } from "./middlewares";
import { openapi } from "./openapi";
import { admin } from "./rutas/admin";
import { intercambio } from "./rutas/intercambio";
import { v1 } from "./rutas/v1";

export function crearApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config().TRUST_PROXY);
  app.use(helmet());

  app.get("/health", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: true });
    } catch {
      res.status(503).json({ ok: false, db: false });
    }
  });
  app.get("/openapi.json", (_req, res) => {
    res.json(openapi);
  });

  // El correo entra crudo (hasta 26 MB) y antes del parser JSON.
  app.use(
    "/v1/intercambio",
    rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }),
    intercambio,
  );

  // JSON grande: un .pfx, un sobre de DTE o un CSV de un mes pueden venir en base64.
  app.use(express.json({ limit: "30mb" }));

  app.use("/admin", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }), admin);
  // Antes de autenticar, por IP (acota el probar keys al azar); después, por API key (ver v1.ts).
  app.use(
    "/v1",
    rateLimit({ windowMs: 60_000, limit: 1_200, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: (req) => ipKeyGenerator(req.ip ?? "") }),
    v1,
  );

  app.use((_req, res) => {
    res.status(404).json({ error: { codigo: "NO_ENCONTRADO", mensaje: "Ruta inexistente." } });
  });
  app.use(manejarErrores);
  return app;
}
