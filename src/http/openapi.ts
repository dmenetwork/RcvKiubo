/**
 * Especificación OpenAPI 3.1 de la API (servida en `GET /openapi.json`). Escrita a mano y compacta:
 * describe rutas, parámetros y cuerpos; las respuestas detalladas están en el README.
 */

type Obj = Record<string, unknown>;

const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: Obj) => ({ content: { "application/json": { schema } } });
const ok = (desc: string, schema: Obj = { type: "object" }) => ({ description: desc, ...json(schema) });
const errores = {
  "400": { $ref: "#/components/responses/Error" },
  "401": { $ref: "#/components/responses/Error" },
  "404": { $ref: "#/components/responses/Error" },
  "502": { $ref: "#/components/responses/Error" },
};
const pathId = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" }, description: "Id del contribuyente" };
const pathDoc = { name: "docId", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const q = (name: string, schema: Obj, description?: string, required = false) => ({ name, in: "query", required, schema, ...(description ? { description } : {}) });

function op(tags: string[], summary: string, extra: Obj = {}, respuesta: Obj = ok("OK")): Obj {
  return { tags, summary, responses: { "200": respuesta, ...errores }, ...extra };
}

const RefDoc: Obj = {
  type: "object",
  required: ["rutEmisor", "tipoDte", "folio"],
  properties: {
    rutEmisor: { type: "string", example: "76086428-5", description: "RUT del EMISOR del documento (en una compra, el proveedor)" },
    tipoDte: { type: "integer", enum: [33, 34, 43] },
    folio: { type: "integer", minimum: 1 },
  },
};

export const openapi: Obj = {
  openapi: "3.1.0",
  info: {
    title: "RcvKiubo",
    version: "0.1.0",
    description:
      "Documentos recibidos y Registro de Compras y Ventas del SII: ingesta de XML de intercambio con verificación " +
      "criptográfica, aceptación/reclamo (WS oficial), estado de DTE, plazos de 8 días, import del CSV del RCV, cruces y webhooks.",
  },
  servers: [{ url: "/" }],
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: { type: "http", scheme: "bearer", description: "API key del consumidor (rk_…)" },
      admin: { type: "http", scheme: "bearer", description: "ADMIN_TOKEN" },
      intercambio: { type: "apiKey", in: "header", name: "x-intercambio-secret" },
    },
    responses: {
      Error: ok("Error", {
        type: "object",
        properties: { error: { type: "object", properties: { codigo: { type: "string" }, mensaje: { type: "string" }, detalles: {} } } },
      }),
    },
    schemas: {
      RefDoc,
      Accion: { type: "string", enum: ["ACD", "RCD", "ERM", "RFP", "RFT"], description: "ACD acepta · RCD reclama contenido · ERM recibo de mercaderías · RFP/RFT falta parcial/total" },
      Contribuyente: {
        type: "object",
        required: ["rut", "ambiente"],
        properties: {
          rut: { type: "string" },
          razonSocial: { type: ["string", "null"] },
          ambiente: { type: "string", enum: ["certificacion", "produccion"] },
          horasAvisoPlazo: { type: "integer", minimum: 1, maximum: 192, default: 48 },
          sincronizarSii: { type: "boolean", default: true },
          sincronizarRcv: { type: "boolean", default: true, description: "Bajar solo el RCV del portal del SII cada 6 h (mes actual y, hasta el día 20, el anterior)" },
        },
      },
      Documento: {
        type: "object",
        description: "Un documento por su identidad (contraparte, tipo, folio), con lo que se sabe por XML, RCV y SII.",
        properties: {
          id: { type: "string" },
          operacion: { type: "string", enum: ["COMPRA", "VENTA"] },
          rutContraparte: { type: "string" },
          tipoDte: { type: "integer" },
          folio: { type: "integer" },
          fechaEmision: { type: ["string", "null"], format: "date" },
          montoTotal: { type: ["integer", "null"] },
          fuentes: { type: "object", properties: { xml: { type: "boolean" }, rcv: { type: "boolean" } } },
          sii: {
            type: "object",
            properties: {
              eventoReceptor: {
                type: ["string", "null"],
                description: "ACD/ERM/RCD/RFP/RFT del historial del SII; RECLAMADO/ACUSE si sólo se sabe por el CSV del RCV",
              },
            },
          },
          plazo: {
            type: ["object", "null"],
            properties: {
              estado: { type: "string", enum: ["no_aplica", "reclamado", "aceptado", "vigente", "por_vencer", "aceptado_tacito", "sin_fecha"] },
              vence: { type: ["string", "null"], format: "date-time" },
              horasRestantes: { type: ["integer", "null"] },
            },
          },
        },
      },
    },
  },
  paths: {
    "/health": { get: { tags: ["sistema"], summary: "Salud del servicio y la base", security: [], responses: { "200": ok("OK") } } },
    "/admin/consumidores": {
      post: op(["admin"], "Crear consumidor (devuelve la API key UNA vez)", { security: [{ admin: [] }], requestBody: json({ type: "object", properties: { nombre: { type: "string" } } }) }),
      get: op(["admin"], "Listar consumidores", { security: [{ admin: [] }] }),
    },
    "/admin/consumidores/{cid}": { patch: op(["admin"], "Activar/desactivar o renombrar", { security: [{ admin: [] }] }) },
    "/admin/consumidores/{cid}/api-keys": { post: op(["admin"], "Nueva API key (rotación)", { security: [{ admin: [] }] }) },
    "/admin/api-keys/{kid}": { delete: op(["admin"], "Revocar API key", { security: [{ admin: [] }] }) },
    "/admin/contribuyentes/{cid}/casilla": {
      put: op(["admin"], "Asignar (o quitar con null) la casilla de intercambio", {
        security: [{ admin: [] }],
        requestBody: json({ type: "object", required: ["correo"], properties: { correo: { type: ["string", "null"], format: "email" } } }),
      }),
    },
    "/admin/correos": { get: op(["admin"], "Correos sin destino o con error", { security: [{ admin: [] }] }) },
    "/admin/correos/{coid}/reprocesar": { post: op(["admin"], "Reprocesar un correo guardado", { security: [{ admin: [] }] }) },
    "/v1/intercambio/entrante": {
      post: op(["intercambio"], "Correo crudo del Email Worker (message/rfc822)", {
        security: [{ intercambio: [] }],
        parameters: [{ name: "x-intercambio-to", in: "header", schema: { type: "string" } }],
        requestBody: { content: { "message/rfc822": { schema: { type: "string", format: "binary" } } } },
      }),
    },
    "/v1/intercambio/latido": { get: op(["intercambio"], "Latido del Email Worker", { security: [{ intercambio: [] }] }) },
    "/v1/yo": { get: op(["consumidor"], "Quién soy") },
    "/v1/webhook": {
      get: op(["webhooks"], "URL configurada"),
      put: op(["webhooks"], "Configurar URL (devuelve el secreto al crearlo o rotarlo)", {
        requestBody: json({ type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, rotarSecreto: { type: "boolean" } } }),
      }),
      delete: op(["webhooks"], "Quitar webhook"),
    },
    "/v1/webhook/probar": { post: op(["webhooks"], "Encolar un evento de prueba") },
    "/v1/webhook/entregas": { get: op(["webhooks"], "Entregas recientes", { parameters: [q("estado", { type: "string", enum: ["pendiente", "entregado", "fallido"] })] }) },
    "/v1/webhook/entregas/{eid}/reintentar": { post: op(["webhooks"], "Reencolar una entrega") },
    "/v1/buzon": { get: op(["intercambio"], "Salud del buzón (latido del Email Worker)") },
    "/v1/padron/{rut}": {
      get: op(["sii"], "Padrón público de emisores electrónicos", {
        parameters: [{ name: "rut", in: "path", required: true, schema: { type: "string" } }, q("ambiente", { type: "string", enum: ["produccion", "certificacion"] })],
      }),
    },
    "/v1/contribuyentes": {
      post: op(["contribuyentes"], "Registrar contribuyente", { requestBody: json(ref("Contribuyente")) }),
      get: op(["contribuyentes"], "Listar contribuyentes"),
    },
    "/v1/contribuyentes/{id}": {
      get: op(["contribuyentes"], "Ver contribuyente", { parameters: [pathId] }),
      patch: op(["contribuyentes"], "Actualizar contribuyente", { parameters: [pathId] }),
    },
    "/v1/contribuyentes/{id}/certificado": {
      put: op(["certificado"], "Cargar o rotar el certificado (.pfx en base64)", {
        parameters: [pathId],
        requestBody: json({ type: "object", required: ["pfxBase64", "clave"], properties: { pfxBase64: { type: "string" }, clave: { type: "string" }, rutTitular: { type: "string" } } }),
      }),
      get: op(["certificado"], "Datos del certificado (sin secretos)", { parameters: [pathId] }),
      delete: op(["certificado"], "Quitar el certificado", { parameters: [pathId] }),
    },
    "/v1/contribuyentes/{id}/certificado/probar": { post: op(["certificado"], "Pedir un token al SII con el certificado", { parameters: [pathId] }) },
    "/v1/contribuyentes/{id}/recibidos": {
      post: op(["documentos"], "Subir un EnvioDTE o DTE recibido (XML crudo o {xmlBase64}). Resultado por DTE: nuevo, completado, duplicado, reemplazado o conflicto", {
        parameters: [pathId],
        requestBody: { content: { "application/xml": { schema: { type: "string" } }, "application/json": { schema: { type: "object", properties: { xmlBase64: { type: "string" } } } } } },
      }),
    },
    "/v1/contribuyentes/{id}/documentos": {
      get: op(["documentos"], "Listar documentos", {
        parameters: [
          pathId,
          q("operacion", { type: "string", enum: ["COMPRA", "VENTA"] }),
          q("periodo", { type: "string", pattern: "^\\d{6}$" }),
          q("desde", { type: "string", format: "date" }),
          q("hasta", { type: "string", format: "date" }),
          q("tipoDte", { type: "integer" }),
          q("rut", { type: "string" }, "RUT contraparte"),
          q("pendientes", { type: "boolean" }, "Compras 33/34/43 sin evento con plazo abierto"),
          q("soloRcv", { type: "boolean" }, "Sólo en RCV (falta el XML)"),
          q("soloXml", { type: "boolean" }),
          q("limite", { type: "integer", maximum: 500 }),
          q("cursor", { type: "string" }),
        ],
      }),
    },
    "/v1/contribuyentes/{id}/documentos/{docId}": { get: op(["documentos"], "Ver documento (?xml=1 incluye el XML)", { parameters: [pathId, pathDoc] }, ok("OK", ref("Documento"))) },
    "/v1/contribuyentes/{id}/documentos/{docId}/xml": { get: op(["documentos"], "Descargar el XML original", { parameters: [pathId, pathDoc] }) },
    "/v1/contribuyentes/{id}/documentos/{docId}/accion": {
      post: op(["documentos"], "Aceptar o reclamar ante el SII", { parameters: [pathId, pathDoc], requestBody: json({ type: "object", properties: { accion: ref("Accion") } }) }),
    },
    "/v1/contribuyentes/{id}/documentos/{docId}/actualizar": { post: op(["documentos"], "Consultar al SII ahora (recepción, eventos, cedible, estado)", { parameters: [pathId, pathDoc] }) },
    "/v1/contribuyentes/{id}/documentos/{docId}/respuesta": {
      post: op(["documentos"], "Generar respuesta de intercambio firmada (RespuestaDTE o EnvioRecibos)", {
        parameters: [pathId, pathDoc],
        requestBody: json({
          type: "object",
          required: ["tipo"],
          properties: {
            tipo: { type: "string", enum: ["resultado", "recibo"] },
            estado: { type: "integer", enum: [0, 1, 2] },
            glosa: { type: "string" },
            recinto: { type: "string" },
            contacto: { type: "object" },
          },
        }),
      }),
    },
    "/v1/contribuyentes/{id}/acciones": { get: op(["documentos"], "Historial de acciones pedidas al SII", { parameters: [pathId] }) },
    "/v1/contribuyentes/{id}/correos": { get: op(["intercambio"], "Correos recibidos", { parameters: [pathId] }) },
    "/v1/contribuyentes/{id}/sii/accion": {
      post: op(["sii"], "Aceptar/reclamar sin documento guardado", { parameters: [pathId], requestBody: json({ allOf: [ref("RefDoc"), { type: "object", properties: { accion: ref("Accion") } }] }) }),
    },
    "/v1/contribuyentes/{id}/sii/eventos": { post: op(["sii"], "Historial de eventos del documento", { parameters: [pathId], requestBody: json(ref("RefDoc")) }) },
    "/v1/contribuyentes/{id}/sii/cedible": { post: op(["sii"], "¿Es cedible?", { parameters: [pathId], requestBody: json(ref("RefDoc")) }) },
    "/v1/contribuyentes/{id}/sii/fecha-recepcion": { post: op(["sii"], "Fecha de recepción en el SII y vencimiento del plazo", { parameters: [pathId], requestBody: json(ref("RefDoc")) }) },
    "/v1/contribuyentes/{id}/sii/estado-dte": {
      post: op(["sii"], "Estado del DTE en el SII (QueryEstDte)", {
        parameters: [pathId],
        requestBody: json({
          type: "object",
          required: ["rutEmisor", "rutReceptor", "tipoDte", "folio", "fechaEmision", "montoTotal"],
          properties: {
            rutEmisor: { type: "string" },
            rutReceptor: { type: "string" },
            tipoDte: { type: "integer" },
            folio: { type: "integer" },
            fechaEmision: { type: "string", format: "date" },
            montoTotal: { type: "integer" },
          },
        }),
      }),
    },
    "/v1/contribuyentes/{id}/rcv": {
      get: op(["rcv"], "El RCV del período en el formato del SII: por operación y estado, resumen y detalle", {
        parameters: [
          pathId,
          q("periodo", { type: "string", pattern: "^\d{6}$" }, "AAAAMM", true),
          q("operacion", { type: "string", enum: ["COMPRA", "VENTA"] }),
          q("estado", { type: "string", enum: ["REGISTRO", "PENDIENTE", "NO_INCLUIR", "RECLAMADO"] }),
        ],
      }),
    },
    "/v1/contribuyentes/{id}/rcv/sincronizar": {
      post: op(["rcv"], "Bajar ahora el RCV del período desde el portal del SII (por defecto, el mes en curso)", {
        parameters: [pathId],
        requestBody: json({ type: "object", properties: { periodo: { type: "string", pattern: "^\d{6}$" } } }),
      }),
    },
    "/v1/contribuyentes/{id}/rcv/sincronizaciones": { get: op(["rcv"], "Historial de bajadas del RCV", { parameters: [pathId] }) },
    "/v1/contribuyentes/{id}/rcv/csv": {
      get: op(["rcv"], "El detalle como el CSV de 'Descargar detalles' del portal", {
        parameters: [pathId, q("periodo", { type: "string" }, undefined, true), q("operacion", { type: "string", enum: ["COMPRA", "VENTA"] }), q("estado", { type: "string" })],
      }),
    },
    "/v1/contribuyentes/{id}/rcv/vista": {
      get: op(["rcv"], "Página HTML con el RCV del período, como en el portal", { parameters: [pathId, q("periodo", { type: "string" }, undefined, true)] }),
    },
    "/v1/contribuyentes/{id}/rcv/importar": {
      post: op(["rcv"], "Importar el CSV del RCV (crudo text/csv + query, o JSON {csvBase64,…})", {
        parameters: [
          pathId,
          q("operacion", { type: "string", enum: ["COMPRA", "VENTA"] }),
          q("periodo", { type: "string" }),
          q("estado", { type: "string", enum: ["REGISTRO", "PENDIENTE", "NO_INCLUIR", "RECLAMADO"] }),
          q("nombreArchivo", { type: "string" }),
        ],
        requestBody: { content: { "text/csv": { schema: { type: "string" } }, "application/json": { schema: { type: "object", properties: { csvBase64: { type: "string" } } } } } },
      }),
    },
    "/v1/contribuyentes/{id}/rcv/importaciones": { get: op(["rcv"], "Importaciones hechas", { parameters: [pathId] }) },
    "/v1/contribuyentes/{id}/rcv/cruce": {
      get: op(["rcv"], "Cruce XML ↔ RCV de un período", { parameters: [pathId, q("periodo", { type: "string" }, undefined, true), q("operacion", { type: "string", enum: ["COMPRA", "VENTA"] })] }),
    },
    "/v1/contribuyentes/{id}/rcv/resumen": { get: op(["rcv"], "Resumen del período por tipo y plazo", { parameters: [pathId, q("periodo", { type: "string" }, undefined, true)] }) },
    "/v1/contribuyentes/{id}/cruce": {
      post: op(["rcv"], "Cruce contra la lista del consumidor", {
        parameters: [pathId],
        requestBody: json({
          type: "object",
          required: ["operacion", "documentos"],
          properties: {
            operacion: { type: "string", enum: ["COMPRA", "VENTA"] },
            periodo: { type: "string" },
            desde: { type: "string", format: "date" },
            hasta: { type: "string", format: "date" },
            documentos: { type: "array", items: { type: "object" } },
          },
        }),
      }),
    },
  },
};
