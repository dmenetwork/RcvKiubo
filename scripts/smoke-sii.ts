/**
 * Prueba EN VIVO contra el SII con un certificado real. No toca la base ni registra eventos (salvo
 * que se pida `--accion`, y entonces lo hace DE VERDAD).
 *
 * Es lo que confirma lo marcado "NO VERIFICADO" en `core/registro-reclamo.ts` y `core/estado-dte.ts`:
 * imprime las respuestas crudas del SII (sin el token) para comparar con los parsers.
 *
 *   PFX_CLAVE='…' npm run smoke:sii -- --pfx ./cert.pfx --ambiente produccion \
 *     --rut-emisor 76086428-5 --tipo 33 --folio 1234 \
 *     [--receptor 77840802-3 --fecha 2026-10-01 --monto 11900] [--accion ACD]
 *
 * La clave va por variable de entorno, no como argumento: así no queda en la lista de procesos.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { leerPfx } from "../src/core/certificado";
import { ACCIONES, type AccionReclamo } from "../src/core/registro-reclamo";
import { ClienteSii, type ContextoSii } from "../src/sii/cliente";

const { values: a } = parseArgs({
  options: {
    pfx: { type: "string" },
    ambiente: { type: "string", default: "certificacion" },
    "rut-emisor": { type: "string" },
    tipo: { type: "string", default: "33" },
    folio: { type: "string" },
    receptor: { type: "string" },
    fecha: { type: "string" },
    monto: { type: "string" },
    accion: { type: "string" },
  },
});
if (!a.pfx || !a["rut-emisor"] || !a.folio || !process.env.PFX_CLAVE) {
  console.error("Faltan --pfx, --rut-emisor, --folio o la variable PFX_CLAVE. Ver el encabezado del script.");
  process.exit(1);
}
const ambiente = a.ambiente === "produccion" ? "produccion" : "certificacion";
const cert = leerPfx(readFileSync(a.pfx), process.env.PFX_CLAVE);
console.log(`Certificado de ${cert.nombreTitular} (${cert.rutTitular ?? "sin RUT"}), vence ${cert.validoHasta.toISOString().slice(0, 10)}`);

// Un fetch que muestra lo que el SII contesta, con el token tapado.
const fetchVerboso = (async (url: string, init: RequestInit) => {
  const res = await fetch(url, init);
  const cuerpo = await res.text();
  const limpio = cuerpo.replace(/(TOKEN(?:&gt;|>))[A-Za-z0-9_-]+/gi, "$1***");
  console.log(`\n── ${new URL(url).pathname} → HTTP ${res.status}\n${limpio.slice(0, 2000)}`);
  return new Response(cuerpo, { status: res.status, headers: res.headers });
}) as typeof fetch;

const sii = new ClienteSii({ fetch: fetchVerboso, reintentos: 0 });
const ctx: ContextoSii = { clave: "smoke", ambiente, certificado: async () => cert.firmante };
const doc = { rutEmisor: a["rut-emisor"], tipoDoc: Number(a.tipo), folio: Number(a.folio) };

const paso = async (nombre: string, fn: () => Promise<unknown>) => {
  try {
    console.log(`\n✔ ${nombre}:`, JSON.stringify(await fn(), null, 2));
  } catch (e) {
    console.log(`\n✘ ${nombre}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

await paso("token", async () => ((await sii.token(ctx)) ? "obtenido" : "vacío"));
await paso("fecha de recepción", () => sii.fechaRecepcion(ctx, doc));
await paso("eventos", () => sii.listarEventos(ctx, doc));
await paso("cedible", () => sii.consultarCedible(ctx, doc));
if (a.receptor && a.fecha && a.monto && cert.rutTitular) {
  await paso("estado del DTE", () =>
    sii.estadoDte(ctx, {
      rutConsultante: cert.rutTitular!,
      rutEmisor: doc.rutEmisor,
      rutReceptor: a.receptor!,
      tipoDte: doc.tipoDoc,
      folio: doc.folio,
      fechaEmision: a.fecha!,
      montoTotal: Number(a.monto),
    }),
  );
}
if (a.accion) {
  if (!(ACCIONES as readonly string[]).includes(a.accion)) throw new Error(`Acción inválida: ${a.accion}`);
  await paso(`REGISTRAR ${a.accion} (de verdad)`, () => sii.registrarAccion(ctx, doc, a.accion as AccionReclamo));
}
