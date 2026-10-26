# RcvKiubo

Servicio de **documentos recibidos y Registro de Compras y Ventas (RCV)** del SII de Chile, para que
cualquier sistema (Kiubo, api-facturacion, …) lo consuma por HTTP.

Por cada contribuyente:

- **Baja el RCV del SII solo**, cada 6 horas: el resumen y el detalle de compras (registro, pendientes,
  no incluir, reclamados) y de ventas, del mes en curso y, hasta el día 20, del anterior. Lo entrega
  en el formato del portal (JSON, CSV de "Descargar detalles" y una página HTML).
- **Recibe los XML** de la casilla de intercambio (Email Worker de Cloudflare o subida directa), los
  **verifica criptográficamente** (firma del documento, timbre, CAF) y los guarda tal como llegaron.
- **Cruza** el RCV con lo que llegó por XML y con la lista del consumidor: facturas que el SII tiene y
  nunca llegaron al buzón, montos distintos, documentos de más.
- **Acepta o reclama** ante el SII (ACD, RCD, ERM, RFP, RFT) por el web service oficial, y deja
  constancia de cada acción.
- **Vigila el plazo de 8 días** de la Ley 19.983 con la fecha de recepción **en el SII**, y avisa
  antes de que venza y cuando opera la aceptación tácita.
- **Pregunta al SII** si cada factura recibida existe y coincide (`QueryEstDte`), su historial de
  eventos y si es cedible.
- **Avisa por webhooks** firmados (HMAC), con reintentos.

## Cómo se obtiene el RCV

No hay un web service oficial del SII para el RCV. Lo entrega el propio portal (`www4.sii.cl/
consdcvinternetui`) por los servicios JSON que usa su pantalla (`facadeService`: `getResumen`,
`getDetalleCompra`, `getDetalleVenta`). RcvKiubo entra a MiSII con el **certificado digital** del
titular (el mismo flujo con que Kiubo ya timbra folios automáticamente) y hace esas consultas.

**Probado en vivo el 2026-10-26** contra producción, con el certificado de Jorge (Node + undici, el
camino del servicio): octubre de 11.598.736-4 completo (592 documentos de compra, 423 de venta; el
detalle cuadró exacto con el resumen en cada tipo) y también el RCV de 77.840.802-3. **No pidió
captcha.**

Hay comentarios de terceros (2024) que dicen que el SII agregó reCAPTCHA a estas consultas. Con
sesión de certificado no ocurrió. Si algún día el SII lo pide, la sincronización **se detiene y avisa**
(`rcv.sincronizacion_fallida`, motivo `captcha`): RcvKiubo nunca resuelve, fabrica ni burla un captcha.
Para ese caso queda el import del CSV que baja una persona del portal (`POST …/rcv/importar`).

Las boletas el SII las informa sólo como total del mes (sin detalle): así quedan en el resumen.

| Necesidad | Cómo | Canal |
|---|---|---|
| El RCV (resumen y detalle) | Portal del SII con sesión de certificado, cada 6 h | Portal del SII |
| Las facturas de compra, con todos sus datos firmados | XML del correo de intercambio | Oficial |
| Aceptar / reclamar, plazo, eventos, cedibilidad | `WSREGISTRORECLAMODTE` con token de semilla | Oficial |
| ¿La factura existe y coincide? | `QueryEstDte` | Oficial |
| ¿El proveedor emite electrónicamente? | Padrón público (Res. Ex. SII 45/2003) | Pública |
| Respaldo si el portal cambia | CSV del RCV que baja una persona | Portal, con humano |

## Qué está verificado y qué no

| Pieza | Estado |
|---|---|
| RCV del portal: login con certificado, `getResumen`, `getDetalleCompra`, `getDetalleVenta` | **Probado en vivo en producción** el 2026-10-26 (Bun y Node + undici) |
| Firma XML, token semilla→token, `QueryEstUp` | Portado de Kiubo, **probado en producción** |
| Token con certificado real; `consultarFechaRecepcionSii`, `listarEventosHistDoc`, `consultarDocDteCedible`; `QueryEstDte` | **Probado en vivo** el 2026-10-26 (8 facturas reales) |
| Códigos de `WSREGISTRORECLAMODTE` (0–25 y −1) | Manual oficial V1.1 + WSDL vivo; 15, 16 y 22 vistos en vivo |
| Registrar eventos (`ingresarAceptacionReclamoDoc`) | Según manual y WSDL; **no se probó en vivo** (tiene efecto tributario) |
| Verificación de firma y timbre de DTE recibidos | Probada con los 32 XML reales del buzón de Belén (falta la llave del SII para el CAF) |
| Import del CSV que baja una persona | Lectura por nombre de columna; el CSV que exporta RcvKiubo se vuelve a leer igual. Falta un archivo real descargado del portal |

`QueryEstDteAv` no se ofrece: en la prueba en vivo el SII rechazó el sobre ("Transacción Rechazada").

Diagnóstico con un certificado a mano: `npm run probar:rcv-portal` (RCV) y `npm run smoke:sii` (web
services). Los dos sólo consultan.

## Arquitectura

```
src/
  core/        dominio PURO y testeado: firma XML, token, sobres SOAP y parsers del SII, lectura y
               verificación de DTE, CSV del RCV, cruces, plazos, sellado AES-GCM, certificado .pfx
  sii/         cliente de los servicios del SII: token cacheado, re-autenticación, reintentos,
               concurrencia acotada. Nunca sale a un host que no sea *.sii.cl
  workers/     lógica con base de datos: consumidores, contribuyentes, certificados, documentos,
               seguimiento, acciones, RCV, intercambio, webhooks, jobs
  http/        Express 5: rutas finas, auth, validación (zod), errores, OpenAPI
email-worker/  el Worker de Cloudflare de la casilla de intercambio (mismo contrato que Kiubo)
scripts/       crear consumidor, smoke en vivo, sonda del portal, re-sellado de llaves
```

Decisiones que importan:

- **Stack**: Node 22 + TypeScript + Express 5 + PostgreSQL + Prisma 7. Build con esbuild a un solo
  archivo.
- **Certificados**: se sube el `.pfx` una vez. Se guarda la **llave privada sellada** con AES-256-GCM
  (llave maestra en el entorno, AAD = id del contribuyente). **La clave del .pfx no se guarda.** El
  `.pfx` se abre con `node-forge` (Node no lee PKCS#12). El aviso de `npm audit` sobre node-forge es de
  su *verificación* de firmas, que acá no se usa.
- **API keys**: se guarda su sha256, nunca la key.
- **Webhooks**: bandeja de salida en la base (outbox), entrega "al menos una vez", firma
  `HMAC-SHA256`, backoff exponencial (1 min → 6 h, 12 intentos).
- **Jobs** en el mismo proceso. Las filas se **reclaman** con `FOR UPDATE SKIP LOCKED` y un arriendo,
  así que varias réplicas se reparten el trabajo sin duplicarlo.
- **Multi-consumidor**: cada sistema es un `Consumidor` con sus keys y sólo ve sus contribuyentes. Dos
  consumidores pueden registrar el mismo RUT.
- **Las casillas de intercambio las asigna el operador** (`PUT /admin/contribuyentes/:id/casilla`), no
  el consumidor: quien tiene la casilla recibe las facturas. Los correos se enrutan SÓLO por casilla,
  nunca adivinando por el RUT.
- **Webhooks sin SSRF**: la IP de destino se valida AL CONECTAR (no sólo el texto de la URL), así que ni
  un DNS que apunta a la red interna ni un rebinding pasan. Reparto justo: a lo más 5 entregas por
  consumidor por ciclo, consumidores en paralelo.

## Puesta en marcha (desarrollo)

```bash
npm install
cp .env.example .env            # completar SELLO_LLAVES, ADMIN_TOKEN, INTERCAMBIO_SECRET
npm run db:up                   # Postgres en :5434 (+ base rcv_kiubo_test para los tests)
npm run db:migrate
npm run dev                     # http://localhost:4100  (/health, /openapi.json)
npm run consumidor:crear -- "Kiubo"   # imprime la API key UNA vez
```

Tests: `npm test` (core + integración contra `DATABASE_URL_TEST`, en serie) · `npm run typecheck`.

## Despliegue

```bash
cp .env.example .env    # + POSTGRES_PASSWORD
docker compose up -d --build
```

La imagen aplica las migraciones al arrancar (`prisma migrate deploy`) y publica el puerto sólo en
`127.0.0.1`: va detrás de un proxy con TLS (nginx o Cloudflare Tunnel). Con un proxy delante,
`TRUST_PROXY=1`.

**La llave maestra (`SELLO_LLAVES`) es la única copia que abre los certificados**: si se pierde, hay
que volver a subirlos todos. Respaldarla aparte de la base. Para rotarla: anteponer una nueva
(`2:NUEVA,1:VIEJA`), reiniciar, correr `npm run resellar`, y quitar la vieja.

## Uso de la API

Todas las rutas `/v1` van con `Authorization: Bearer rk_…`. Errores: `{ "error": { "codigo", "mensaje", "detalles"? } }`.
La especificación completa está en `GET /openapi.json`.

```bash
API=https://rcv.tudominio.cl; K="Authorization: Bearer rk_…"

# 1. Contribuyente (RUT de la empresa) y su certificado
curl -X POST $API/v1/contribuyentes -H "$K" -H 'content-type: application/json' \
  -d '{"rut":"77840802-3","ambiente":"produccion"}'
# (operador) la casilla de intercambio de ese contribuyente
curl -X PUT $API/admin/contribuyentes/$ID/casilla -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"correo":"belen.castro@dte.kiubo.io"}'
curl -X PUT $API/v1/contribuyentes/$ID/certificado -H "$K" -H 'content-type: application/json' \
  -d "{\"pfxBase64\":\"$(base64 -w0 cert.pfx)\",\"clave\":\"…\"}"
curl -X POST $API/v1/contribuyentes/$ID/certificado/probar -H "$K"    # el SII emite un token

# 2. Webhook (el secreto se muestra una vez)
curl -X PUT $API/v1/webhook -H "$K" -H 'content-type: application/json' -d '{"url":"https://kiubo/hooks/rcv"}'

# 3. Documentos: subir un XML (si no llegan por el Email Worker), ver pendientes, aceptar
curl -X POST $API/v1/contribuyentes/$ID/recibidos -H "$K" -H 'content-type: application/xml' --data-binary @envio.xml
curl "$API/v1/contribuyentes/$ID/documentos?pendientes=true" -H "$K"
curl -X POST $API/v1/contribuyentes/$ID/documentos/$DOC/accion -H "$K" -H 'content-type: application/json' -d '{"accion":"ACD"}'

# 4. RCV: lo baja solo cada 6 h; para forzarlo ahora y verlo como en el portal
curl -X POST $API/v1/contribuyentes/$ID/rcv/sincronizar -H "$K" -H 'content-type: application/json' -d '{"periodo":"202610"}'
curl "$API/v1/contribuyentes/$ID/rcv?periodo=202610" -H "$K"                       # resumen + detalle (JSON)
curl "$API/v1/contribuyentes/$ID/rcv/csv?periodo=202610&operacion=COMPRA&estado=REGISTRO" -H "$K" -o compras.csv
curl "$API/v1/contribuyentes/$ID/rcv/vista?periodo=202610" -H "$K" -o rcv.html     # página como el portal

# 4b. Respaldo: subir el CSV que bajó una persona del portal, y cruzar
curl -X POST "$API/v1/contribuyentes/$ID/rcv/importar?nombreArchivo=RCV_COMPRA_REGISTRO_77840802-3_202610.csv" \
  -H "$K" -H 'content-type: text/csv' --data-binary @RCV_COMPRA_REGISTRO_77840802-3_202610.csv
curl "$API/v1/contribuyentes/$ID/rcv/cruce?periodo=202610" -H "$K"
```

Para un consumidor que ya tiene sus documentos y sólo quiere hablar con el SII, están las rutas
`/v1/contribuyentes/:id/sii/{accion,eventos,cedible,fecha-recepcion,estado-dte}` (no requieren el
documento guardado), y `POST /v1/contribuyentes/:id/cruce` para cruzar su propia lista.

### Cada documento

Un documento es único por (contribuyente, operación, RUT contraparte, tipo, folio) y junta tres
fuentes: `fuentes.xml`, `fuentes.rcv` y `sii` (fecha de recepción, evento vigente, eventos,
cedibilidad, estado). `plazo.estado` es uno de: `vigente`, `por_vencer`, `aceptado`, `reclamado`,
`aceptado_tacito`, `sin_fecha` (aún no se sabe la recepción en el SII; nunca se da por vencido sin
ella) o `no_aplica` (tipos sin registro: 61, 56, 52…).

Un segundo XML **distinto** para un folio que ya estaba (un folio no se reemite) alerta siempre, y gana
el que **verifica mejor**: todo verificado (incluido el CAF contra la llave del SII) > sin fallas pero
sin la llave > con fallas. A igual nivel se conserva el primero (`conflicto`); si el nuevo verifica
mejor, `reemplazado`. Así un DTE falso que llegue primero a la casilla (es pública) no bloquea al
verdadero, y uno falso que llegue después no lo pisa. Un XML con fallas tampoco pisa los montos que
registró el SII en el RCV.

`sii.eventoReceptor` es el código del historial del SII (ACD, ERM, RCD, RFP, RFT) o, si sólo se sabe
por el CSV del RCV, el marcador `RECLAMADO` o `ACUSE`, que el historial reemplaza al consultarlo.

## Webhooks

`POST` a la URL configurada con `X-RcvKiubo-Evento`, `X-RcvKiubo-Entrega` (id, para deduplicar) y
`X-RcvKiubo-Firma: t=<unix>,v1=<hex>`, donde `v1 = HMAC-SHA256(secreto, "<t>.<cuerpo>")`.

| Evento | Cuándo |
|---|---|
| `documento.recibido` | Entró un XML nuevo (o completó uno conocido sólo por el RCV) |
| `documento.alerta` | Verificación criptográfica fallida, XML distinto para el mismo folio, el SII dice `DNK`/anulado/no autorizado, o el seguimiento se detuvo por errores (`motivo`) |
| `documento.evento` | Cambió el evento vigente (ACD, ERM, RCD, RFP, RFT), registrado acá o visto en el SII |
| `documento.plazo_por_vencer` | Quedan menos de `horasAvisoPlazo` (48 por defecto) y no hay evento. Una vez |
| `documento.aceptado_tacito` | Venció el plazo sin reclamo |
| `rcv.importado` | Se importó un CSV; trae los documentos que están en el RCV y no llegaron por XML |
| `rcv.sincronizado` | Se bajó el RCV del portal; trae cuántos documentos y cuántas compras no llegaron por XML |
| `rcv.sincronizacion_fallida` | La bajada falló (`motivo`: `error`, o `captcha` si el SII llegara a pedirlo) |
| `certificado.por_vencer` | Vence en 30 días o menos (a lo más una vez por semana) |
| `correo.error` | Un correo de la casilla no se pudo procesar completo |

Verificación del lado del consumidor (TypeScript):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
function firmaValida(cabecera: string, secreto: string, cuerpoCrudo: string): boolean {
  const p = Object.fromEntries(cabecera.split(",").map((x) => x.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(p.t)) > 300) return false;   // ventana anti-reenvío
  const esperado = createHmac("sha256", secreto).update(`${p.t}.${cuerpoCrudo}`).digest();
  const recibido = Buffer.from(p.v1 ?? "", "hex");
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}
```

## Jobs

| Job | Cada | Qué hace |
|---|---|---|
| `revision-sii` | 1 min | Para los documentos con `proximaRevisionEn` vencida: fecha de recepción, eventos, cedibilidad y estado. Vuelve cada 6 h mientras el plazo esté abierto; con backoff si el SII aún no lo tiene |
| `sincronizacion-rcv` | 6 h | Baja el RCV de cada contribuyente con certificado y `sincronizarRcv` (mes actual y, hasta el día 20, el anterior) |
| `avisos-plazo` | 10 min | Plazo por vencer y aceptación tácita (una vez cada uno; la tácita, sólo después de la última revisión contra el SII) |
| `avisos-certificado` | 6 h | Certificados por vencer |
| `webhooks` | 10 s | Entrega de la bandeja de salida |
| `limpieza` | 1 día | Borra entregas de más de 30 días y suelta los crudos de correos con error |

`JOBS_ACTIVOS=false` para un proceso que sólo atiende HTTP.

Si una revisión falla 15 veces seguidas, el seguimiento de ese documento se detiene y se avisa
(`documento.alerta`, motivo `seguimiento_detenido`). Cargar o renovar el certificado, o volver a
prender `sincronizarSii`, lo retoma solo.

## Casilla de intercambio (Email Worker)

`email-worker/` es el Worker de Kiubo con el mismo contrato (`POST /v1/intercambio/entrante` con
`x-intercambio-secret` y `x-intercambio-to`, más el latido `GET /v1/intercambio/latido`). Reenvía una
copia, entrega el crudo, guarda en KV lo que no pudo entregar y reintenta cada 10 minutos. Setup:
copiar `wrangler.toml.example`, crear el KV, `wrangler secret put INTERCAMBIO_SECRET` (el mismo valor
del `.env`), `wrangler deploy`, y en Email Routing una regla por casilla → el Worker. Cada
contribuyente se enruta por su `correoIntercambio` (lo asigna el operador). `GET /v1/buzon` dice si el
Worker está vivo (latido de menos de 2 h).

Un correo que llega a una casilla sin asignar queda `sin_destino` con su crudo guardado:
`GET /admin/correos` los lista y `POST /admin/correos/:id/reprocesar` lo ingresa después de asignar la
casilla. El mismo correo a dos casillas cuenta como dos entradas.

## Llaves públicas del SII

La FRMA de cada CAF la firma el SII: `SII_LLAVE_IDK_100` (certificación) y `SII_LLAVE_IDK_300`
(producción), en PEM. Sin ellas, la verificación de un DTE recibido no puede probar el CAF
(`sinLlaveSii: true`): no falla ni pasa. Conseguirlas de una fuente verificable y contrastar la
huella con una segunda fuente; una llave equivocada rechaza todas las facturas buenas.

## Origen del código

`src/core/{rut,xml-lineal,dte-firma,dte-token,dte-impuestos,dte-ted,dte-recepcion,dte-verificacion,
dte-intercambio,dte-respuesta,padron-sii}.ts` y sus tests son un port de `belen-abos/api/core`
(Kiubo), donde están probados en producción. Sus comentarios citan rutas de ese repo (`docs/…`,
`workers/…`).
