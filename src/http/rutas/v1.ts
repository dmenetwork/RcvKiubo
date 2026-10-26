import express, { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { ACCIONES } from "../../core/registro-reclamo";
import { ESTADOS_RCV } from "../../core/rcv-csv";
import { rutSii } from "../../core/rut";
import { prisma } from "../../db";
import { ErrorHttp } from "../../errores";
import {
  accionDirecta,
  accionesRegistradas,
  cedibleDirecto,
  estadoDteDirecto,
  eventosDirecto,
  fechaRecepcionDirecto,
  refrescarDocumentoPedido,
  registrarAccionDocumento,
} from "../../workers/acciones";
import { cargarCertificado, contextoSii, quitarCertificado, resumenCertificado } from "../../workers/certificados";
import { configurarWebhook, quitarWebhook } from "../../workers/consumidores";
import { actualizarContribuyente, contribuyenteDe, crearContribuyente, listarContribuyentes } from "../../workers/contribuyentes";
import { documentoDe, ingresarXml, listarDocumentos, serializarDocumento } from "../../workers/documentos";
import { estadoBuzon, listarCorreos } from "../../workers/intercambio";
import { cruceConConsumidor, cruceRcv, importarCsv, listarImportaciones, resumenPeriodo } from "../../workers/rcv";
import { listarSincronizaciones, periodoActual, rcvDelPeriodo, sincronizarRcvPedido } from "../../workers/rcv-portal";
import { csvRcv, htmlRcv } from "../../core/rcv-formato";
import { generarRespuesta } from "../../workers/respuestas";
import { clienteSii } from "../../workers/sii";
import { enviarPrueba, listarEntregas, reintentarEntrega } from "../../workers/webhooks";
import { actorDe, conApiKey, validar } from "../middlewares";

/** La API de los consumidores: `Authorization: Bearer rk_…`. */
export const v1 = Router();
v1.use(conApiKey);
// Por API key, no por IP: varios consumidores pueden salir por el mismo NAT.
v1.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: (req) => req.actor?.apiKeyId ?? req.actor?.consumidorId ?? "?" }));

// ── Esquemas ──────────────────────────────────────────────────────────────────────────────────

const rut = z.string().trim().refine((v) => rutSii(v) !== "", "RUT inválido (revisa el dígito verificador)");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha AAAA-MM-DD");
const periodo = z.string().regex(/^\d{4}(0[1-9]|1[0-2])$/, "período AAAAMM");
const entero = z.coerce.number().int();
const folio = entero.min(1).max(2_147_483_647);
const operacion = z.enum(["COMPRA", "VENTA"]);
const uuid = z.string().uuid();

const refDoc = z.object({ rutEmisor: rut, tipoDte: entero.positive(), folio });

const idContribuyente = (req: Request) => validar(uuid, req.params.id);

/** XML/CSV como cuerpo crudo, o en JSON como base64. */
const crudo = express.raw({ type: ["application/xml", "text/xml", "text/csv", "text/plain", "application/octet-stream"], limit: "30mb" });
function bytesDe(req: Request, campoBase64: string): Buffer {
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return req.body;
  const v = (req.body as Record<string, unknown> | undefined)?.[campoBase64];
  if (typeof v === "string" && v.length > 0) return Buffer.from(v, "base64");
  throw new ErrorHttp(400, "CUERPO_VACIO", `Manda el archivo como cuerpo crudo o en JSON como \`${campoBase64}\`.`);
}

// ── Consumidor ────────────────────────────────────────────────────────────────────────────────

v1.get("/yo", async (req, res) => {
  const a = actorDe(req);
  const c = await prisma.consumidor.findUniqueOrThrow({ where: { id: a.consumidorId }, select: { id: true, nombre: true, webhookUrl: true } });
  res.json({ ...c, apiKeyId: a.apiKeyId });
});

v1.get("/webhook", async (req, res) => {
  const c = await prisma.consumidor.findUniqueOrThrow({ where: { id: actorDe(req).consumidorId }, select: { webhookUrl: true } });
  res.json({ url: c.webhookUrl });
});

v1.put("/webhook", async (req, res) => {
  const p = validar(z.object({ url: z.string().url(), rotarSecreto: z.boolean().optional() }), req.body);
  // El secreto se devuelve sólo cuando se crea o se rota: guárdalo para verificar las firmas.
  res.json(await configurarWebhook(actorDe(req), p.url, p.rotarSecreto));
});

v1.delete("/webhook", async (req, res) => {
  await quitarWebhook(actorDe(req));
  res.status(204).end();
});

v1.post("/webhook/probar", async (req, res) => {
  await enviarPrueba(actorDe(req));
  res.status(202).json({ encolado: true });
});

v1.get("/webhook/entregas", async (req, res) => {
  const q = validar(z.object({ estado: z.enum(["pendiente", "entregado", "fallido"]).optional(), limite: entero.min(1).max(200).optional() }), req.query);
  res.json({ entregas: await listarEntregas(actorDe(req), q) });
});

v1.post("/webhook/entregas/:entregaId/reintentar", async (req, res) => {
  await reintentarEntrega(actorDe(req), validar(uuid, req.params.entregaId));
  res.status(202).json({ encolado: true });
});

v1.get("/buzon", async (_req, res) => {
  res.json(await estadoBuzon());
});

v1.get("/padron/:rut", async (req, res) => {
  const r = rutSii(req.params.rut ?? "");
  if (!r) throw new ErrorHttp(400, "RUT_INVALIDO", "RUT inválido.");
  const ambiente = validar(z.enum(["produccion", "certificacion"]).default("produccion"), req.query.ambiente);
  res.json({ rut: r, ...(await clienteSii().padron(r, ambiente)) });
});

// ── Contribuyentes ────────────────────────────────────────────────────────────────────────────

// La casilla de intercambio NO va acá: la asigna el operador (PUT /admin/contribuyentes/:id/casilla).
const datosContribuyente = z.object({
  razonSocial: z.string().trim().max(200).nullable().optional(),
  horasAvisoPlazo: entero.min(1).max(192).optional(),
  sincronizarSii: z.boolean().optional(),
  sincronizarRcv: z.boolean().optional(),
});

const conCertificado = async <T extends { id: string }>(c: T) => {
  const cert = await prisma.certificado.findUnique({ where: { contribuyenteId: c.id } });
  return { ...c, certificado: cert ? resumenCertificado(cert) : null };
};

v1.post("/contribuyentes", async (req, res) => {
  const d = validar(datosContribuyente.extend({ rut, ambiente: z.enum(["certificacion", "produccion"]) }), req.body);
  res.status(201).json(await conCertificado(await crearContribuyente(actorDe(req), d)));
});

v1.get("/contribuyentes", async (req, res) => {
  const lista = await listarContribuyentes(actorDe(req));
  res.json({ contribuyentes: lista.map(({ certificado, ...c }) => ({ ...c, certificado })) });
});

v1.get("/contribuyentes/:id", async (req, res) => {
  res.json(await conCertificado(await contribuyenteDe(actorDe(req), idContribuyente(req))));
});

v1.patch("/contribuyentes/:id", async (req, res) => {
  const d = validar(datosContribuyente.extend({ activo: z.boolean().optional() }), req.body);
  res.json(await conCertificado(await actualizarContribuyente(actorDe(req), idContribuyente(req), d)));
});

// ── Certificado ───────────────────────────────────────────────────────────────────────────────

v1.put("/contribuyentes/:id/certificado", async (req, res) => {
  const p = validar(z.object({ pfxBase64: z.string().min(100), clave: z.string(), rutTitular: rut.optional() }), req.body);
  res.json(await cargarCertificado(actorDe(req), idContribuyente(req), Buffer.from(p.pfxBase64, "base64"), p.clave, { rutTitular: p.rutTitular }));
});

v1.get("/contribuyentes/:id/certificado", async (req, res) => {
  const c = await contribuyenteDe(actorDe(req), idContribuyente(req));
  const cert = await prisma.certificado.findUnique({ where: { contribuyenteId: c.id } });
  if (!cert) throw new ErrorHttp(404, "SIN_CERTIFICADO", "El contribuyente no tiene certificado.");
  res.json(resumenCertificado(cert));
});

v1.delete("/contribuyentes/:id/certificado", async (req, res) => {
  await quitarCertificado(actorDe(req), idContribuyente(req));
  res.status(204).end();
});

/** Prueba de punta a punta: pide un token al SII con el certificado. No consume nada. */
v1.post("/contribuyentes/:id/certificado/probar", async (req, res) => {
  const c = await contribuyenteDe(actorDe(req), idContribuyente(req));
  const sii = clienteSii();
  sii.invalidarToken(c.id);
  await sii.token(contextoSii(c));
  res.json({ ok: true, ambiente: c.ambiente, mensaje: "El SII emitió un token con este certificado." });
});

// ── Documentos ────────────────────────────────────────────────────────────────────────────────

v1.post("/contribuyentes/:id/recibidos", crudo, async (req, res) => {
  res.status(201).json(await ingresarXml(actorDe(req), idContribuyente(req), bytesDe(req, "xmlBase64")));
});

v1.get("/contribuyentes/:id/documentos", async (req, res) => {
  const bool = z.enum(["true", "false"]).transform((v) => v === "true").optional();
  const f = validar(
    z.object({
      operacion: operacion.optional(),
      periodo: periodo.optional(),
      desde: ymd.optional(),
      hasta: ymd.optional(),
      tipoDte: entero.positive().optional(),
      rut: rut.optional(),
      pendientes: bool,
      soloRcv: bool,
      soloXml: bool,
      limite: entero.min(1).max(500).optional(),
      cursor: uuid.optional(),
    }),
    req.query,
  );
  res.json(await listarDocumentos(actorDe(req), idContribuyente(req), { ...f, rutContraparte: f.rut }));
});

v1.get("/contribuyentes/:id/documentos/:docId", async (req, res) => {
  const { c, d } = await documentoDe(actorDe(req), idContribuyente(req), String(req.params.docId));
  res.json(serializarDocumento(d, { horasAviso: c.horasAvisoPlazo, conXml: req.query.xml === "1" || req.query.xml === "true" }));
});

/** El XML tal como llegó, en sus bytes originales (para archivar o re-verificar). */
v1.get("/contribuyentes/:id/documentos/:docId/xml", async (req, res) => {
  const { d } = await documentoDe(actorDe(req), idContribuyente(req), String(req.params.docId));
  if (!d.xml) throw new ErrorHttp(404, "SIN_XML", "Este documento sólo se conoce por el RCV: no hay XML.");
  const latin1 = d.codificacion !== "utf8";
  res
    .type(`application/xml; charset=${latin1 ? "ISO-8859-1" : "UTF-8"}`)
    .setHeader("Content-Disposition", `attachment; filename="DTE_${d.rutContraparte}_T${d.tipoDte}F${d.folio}.xml"`)
    .send(Buffer.from(d.xml, latin1 ? "latin1" : "utf8"));
});

v1.post("/contribuyentes/:id/documentos/:docId/accion", async (req, res) => {
  const { accion } = validar(z.object({ accion: z.enum(ACCIONES) }), req.body);
  res.json(await registrarAccionDocumento(actorDe(req), idContribuyente(req), String(req.params.docId), accion));
});

v1.post("/contribuyentes/:id/documentos/:docId/actualizar", async (req, res) => {
  res.json(await refrescarDocumentoPedido(actorDe(req), idContribuyente(req), String(req.params.docId)));
});

v1.post("/contribuyentes/:id/documentos/:docId/respuesta", async (req, res) => {
  const p = validar(
    z.object({
      tipo: z.enum(["resultado", "recibo"]),
      estado: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
      glosa: z.string().max(256).optional(),
      recinto: z.string().max(80).optional(),
      contacto: z.object({ nombre: z.string().max(40).optional(), fono: z.string().max(40).optional(), mail: z.string().email().max(80).optional() }).optional(),
      idRespuesta: entero.min(1).max(9_999_999_999).optional(),
      codigoEnvio: entero.min(1).max(9_999_999_999).optional(),
    }),
    req.body,
  );
  const { xml, nombre } = await generarRespuesta(actorDe(req), idContribuyente(req), String(req.params.docId), p);
  res.type("application/xml; charset=ISO-8859-1").setHeader("Content-Disposition", `attachment; filename="${nombre}"`).send(xml);
});

v1.get("/contribuyentes/:id/acciones", async (req, res) => {
  const { limite } = validar(z.object({ limite: entero.min(1).max(500).optional() }), req.query);
  res.json({ acciones: await accionesRegistradas(actorDe(req), idContribuyente(req), limite) });
});

v1.get("/contribuyentes/:id/correos", async (req, res) => {
  const c = await contribuyenteDe(actorDe(req), idContribuyente(req));
  res.json({ correos: await listarCorreos(c.id, Number(req.query.limite) || 50) });
});

// ── SII directo (sin documento guardado) ──────────────────────────────────────────────────────

v1.post("/contribuyentes/:id/sii/accion", async (req, res) => {
  const p = validar(refDoc.extend({ accion: z.enum(ACCIONES) }), req.body);
  res.json(await accionDirecta(actorDe(req), idContribuyente(req), p));
});

v1.post("/contribuyentes/:id/sii/eventos", async (req, res) => {
  res.json(await eventosDirecto(actorDe(req), idContribuyente(req), validar(refDoc, req.body)));
});

v1.post("/contribuyentes/:id/sii/cedible", async (req, res) => {
  res.json(await cedibleDirecto(actorDe(req), idContribuyente(req), validar(refDoc, req.body)));
});

v1.post("/contribuyentes/:id/sii/fecha-recepcion", async (req, res) => {
  res.json(await fechaRecepcionDirecto(actorDe(req), idContribuyente(req), validar(refDoc, req.body)));
});

v1.post("/contribuyentes/:id/sii/estado-dte", async (req, res) => {
  const p = validar(
    z.object({
      rutEmisor: rut,
      rutReceptor: rut,
      tipoDte: entero.positive(),
      folio,
      fechaEmision: ymd,
      montoTotal: entero.min(0),
    }),
    req.body,
  );
  res.json(await estadoDteDirecto(actorDe(req), idContribuyente(req), p));
});

// ── RCV ───────────────────────────────────────────────────────────────────────────────────────

v1.post("/contribuyentes/:id/rcv/importar", crudo, async (req, res) => {
  const fuente = Buffer.isBuffer(req.body) ? req.query : { ...req.query, ...(req.body as object) };
  const p = validar(
    z.object({
      operacion: operacion.optional(),
      periodo: periodo.optional(),
      estado: z.enum(ESTADOS_RCV as [string, ...string[]]).optional(),
      nombreArchivo: z.string().max(200).optional(),
    }),
    fuente,
  );
  const r = await importarCsv(actorDe(req), idContribuyente(req), bytesDe(req, "csvBase64"), p as Parameters<typeof importarCsv>[3]);
  res.status(r.yaImportado ? 200 : 201).json(r);
});

/** Baja ahora el RCV del período desde el portal del SII (por defecto, el mes en curso). */
v1.post("/contribuyentes/:id/rcv/sincronizar", async (req, res) => {
  const { periodo: p } = validar(z.object({ periodo: periodo.optional() }), req.body ?? {});
  res.json(await sincronizarRcvPedido(actorDe(req), idContribuyente(req), p ?? periodoActual(new Date())));
});

v1.get("/contribuyentes/:id/rcv/sincronizaciones", async (req, res) => {
  res.json({ sincronizaciones: await listarSincronizaciones(actorDe(req), idContribuyente(req)) });
});

const filtroRcv = z.object({ periodo, operacion: operacion.optional(), estado: z.enum(ESTADOS_RCV as [string, ...string[]]).optional() });

/** El RCV del período en el formato del SII: por operación y estado, el resumen y el detalle. */
v1.get("/contribuyentes/:id/rcv", async (req, res) => {
  const q = validar(filtroRcv, req.query);
  res.json(await rcvDelPeriodo(actorDe(req), idContribuyente(req), q.periodo, q as never));
});

/** El detalle como el CSV de "Descargar detalles" del portal (una operación y un estado). */
v1.get("/contribuyentes/:id/rcv/csv", async (req, res) => {
  const q = validar(filtroRcv.extend({ operacion: operacion.default("COMPRA") }), req.query);
  const estado = q.operacion === "COMPRA" ? (q.estado ?? "REGISTRO") : undefined;
  const r = await rcvDelPeriodo(actorDe(req), idContribuyente(req), q.periodo, { operacion: q.operacion, estado: estado as never });
  const filas = r.secciones.flatMap((s) => (s.operacion === "VENTA" || s.estado === estado ? s.detalle : []));
  res
    .type("text/csv; charset=utf-8")
    .setHeader("Content-Disposition", `attachment; filename="RCV_${q.operacion}${estado ? `_${estado}` : ""}_${r.contribuyente.rut}_${q.periodo}.csv"`)
    // BOM: sin él, Excel abre el UTF-8 como Latin-1 y rompe las tildes de las razones sociales.
    .send(String.fromCharCode(0xfeff) + csvRcv(q.operacion, filas));
});

/** Página autocontenida con el RCV del período, para mirarlo como en el portal. */
v1.get("/contribuyentes/:id/rcv/vista", async (req, res) => {
  const q = validar(filtroRcv, req.query);
  const r = await rcvDelPeriodo(actorDe(req), idContribuyente(req), q.periodo, q as never);
  res.type("text/html; charset=utf-8").send(htmlRcv({ rut: r.contribuyente.rut, razonSocial: r.contribuyente.razonSocial, periodo: r.periodo, sincronizadoEn: r.sincronizadoEn, secciones: r.secciones }));
});

v1.get("/contribuyentes/:id/rcv/importaciones", async (req, res) => {
  res.json({ importaciones: await listarImportaciones(actorDe(req), idContribuyente(req)) });
});

v1.get("/contribuyentes/:id/rcv/cruce", async (req, res) => {
  const q = validar(z.object({ periodo, operacion: operacion.default("COMPRA") }), req.query);
  res.json(await cruceRcv(actorDe(req), idContribuyente(req), q.periodo, q.operacion));
});

v1.get("/contribuyentes/:id/rcv/resumen", async (req, res) => {
  const q = validar(z.object({ periodo }), req.query);
  res.json(await resumenPeriodo(actorDe(req), idContribuyente(req), q.periodo));
});

v1.post("/contribuyentes/:id/cruce", async (req, res) => {
  const p = validar(
    z.object({
      operacion,
      periodo: periodo.optional(),
      desde: ymd.optional(),
      hasta: ymd.optional(),
      documentos: z
        .array(
          z.object({
            rutContraparte: z.string(),
            tipoDte: entero.positive(),
            folio,
            montoTotal: entero.nullable().optional(),
            fechaEmision: ymd.nullable().optional(),
            referencia: z.string().max(200).nullable().optional(),
          }),
        )
        .max(50_000),
    }),
    req.body,
  );
  res.json(await cruceConConsumidor(actorDe(req), idContribuyente(req), p));
});
