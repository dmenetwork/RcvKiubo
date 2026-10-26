/**
 * Diagnóstico EN VIVO del RCV con un certificado real, con el mismo cliente que usa el servicio
 * (`sii/portal.ts`). Sólo lectura: imprime el resumen y cuántos documentos trae cada detalle. Si el
 * SII llegara a pedir captcha, se detiene (el cliente no lo resuelve ni lo burla).
 *
 *   PFX_CLAVE='…' npm run probar:rcv-portal -- --pfx ./cert.pfx --rut 77840802-3 --periodo 202610
 *
 * Probado el 2026-10-26 contra producción (certificado de Jorge, Node + undici): respondió sin captcha.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { leerPfx } from "../src/core/certificado";
import { ESTADOS_COMPRA } from "../src/core/rcv-portal";
import { rutSii } from "../src/core/rut";
import { SesionRcv } from "../src/sii/portal";

const { values: a } = parseArgs({ options: { pfx: { type: "string" }, rut: { type: "string" }, periodo: { type: "string" } } });
const rut = rutSii(a.rut ?? "");
if (!a.pfx || !rut || !/^\d{6}$/.test(a.periodo ?? "") || !process.env.PFX_CLAVE) {
  console.error("Uso: PFX_CLAVE=… npm run probar:rcv-portal -- --pfx cert.pfx --rut 77840802-3 --periodo 202610");
  process.exit(1);
}
const cert = leerPfx(readFileSync(a.pfx), process.env.PFX_CLAVE);
if (!cert.rutTitular) throw new Error("El certificado no trae el RUT del titular.");
const s = await SesionRcv.abrir(cert.firmante, cert.rutTitular);
console.log(`✔ Sesión de MiSII con el certificado de ${cert.nombreTitular}`);
try {
  for (const [operacion, estados] of [["COMPRA", ESTADOS_COMPRA], ["VENTA", ["REGISTRO"]]] as const) {
    for (const estado of estados) {
      for (const r of await s.resumen(rut, a.periodo!, operacion, estado)) {
        const detalle = r.tieneDetalle ? (await s.detalle(rut, a.periodo!, operacion, operacion === "COMPRA" ? estado : "", r.tipoDte)).length : null;
        console.log(`${operacion} ${estado} · ${r.nombreTipoDoc} (${r.tipoDte}): ${r.totalDocumentos} documentos, total $${r.montoTotal}` + (detalle === null ? " (sólo total)" : `, detalle ${detalle}`));
      }
    }
  }
} finally {
  await s.cerrar();
}
