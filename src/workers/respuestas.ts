import {
  TIPOS_CON_RECIBO,
  serializarEnvioRecibos,
  serializarRespuestaDte,
  type EstadoDte,
} from "../core/dte-respuesta";
import { ErrorHttp } from "../errores";
import { firmanteDe } from "./certificados";
import type { Actor } from "./consumidores";
import { documentoDe } from "./documentos";
import { auditar } from "./auditoria";

/**
 * Las respuestas de intercambio que el RECEPTOR le manda al proveedor por correo, firmadas con el
 * certificado del contribuyente:
 *
 * - `resultado` → `RespuestaDTE/ResultadoDTE`: aprobación comercial (0 aceptado, 1 con
 *   discrepancias, 2 rechazado).
 * - `recibo` → `EnvioRecibos`: acuse de recibo de mercaderías de la Ley 19.983. Exige el recinto.
 *
 * Ninguna de las dos produce efecto ante el SII: eso es el registro de aceptación/reclamo
 * (`POST …/accion`). Se generan para el proveedor que las espera por correo; el envío lo hace el
 * consumidor. El acuse del ENVÍO (`RecepcionEnvio`) no se genera: exige datos del sobre original
 * (nombre del archivo, ID del SetDTE) que se leen al recibir, y el consumidor que lo necesite lo arma
 * en ese momento con `core/dte-respuesta`.
 */

export interface PedidoRespuesta {
  tipo: "resultado" | "recibo";
  estado?: EstadoDte;
  glosa?: string;
  recinto?: string;
  contacto?: { nombre?: string; fono?: string; mail?: string };
  /** `IdRespuesta`/`CodEnvio`: positivos, ≤10 dígitos. Por defecto, derivados del momento. */
  idRespuesta?: number;
  codigoEnvio?: number;
}

export async function generarRespuesta(actor: Actor, contribuyenteId: string, documentoId: string, p: PedidoRespuesta, ahora = new Date()) {
  const { c, d } = await documentoDe(actor, contribuyenteId, documentoId);
  if (d.operacion !== "COMPRA") throw new ErrorHttp(422, "SOLO_RECEPTOR", "Las respuestas de intercambio son del receptor: este documento es una venta.");
  if (!d.fechaEmision || d.montoTotal === null) {
    throw new ErrorHttp(422, "DOCUMENTO_INCOMPLETO", "El documento no tiene fecha de emisión o monto total: no se puede responder sin inventarlos.");
  }
  const firmante = await firmanteDe(c.id);
  const contacto = { nombreContacto: p.contacto?.nombre ?? null, fonoContacto: p.contacto?.fono ?? null, mailContacto: p.contacto?.mail ?? null };
  const id = p.idRespuesta ?? (Math.floor(ahora.getTime() / 1000) % 1_000_000_000) + 1;
  const comun = {
    fechaEmision: d.fechaEmision.toISOString().slice(0, 10),
    rutEmisor: d.rutContraparte,
    rutReceptor: c.rut,
    montoTotal: Number(d.montoTotal),
    folio: d.folio,
  };

  let xml: Buffer;
  try {
    if (p.tipo === "resultado") {
      xml = serializarRespuestaDte(
        { rutResponde: c.rut, rutRecibe: d.rutContraparte, idRespuesta: id, ...contacto },
        {
          tipo: "resultado",
          documentos: [
            {
              ...comun,
              tipoDte: d.tipoDte,
              codigoEnvio: p.codigoEnvio ?? id,
              estado: p.estado ?? 0,
              glosa: p.glosa ?? (p.estado === 2 ? "Documento rechazado" : "Documento aceptado"),
            },
          ],
        },
        firmante,
        ahora,
      );
    } else {
      if (!TIPOS_CON_RECIBO.has(d.tipoDte)) {
        throw new ErrorHttp(422, "TIPO_SIN_RECIBO", `El esquema del SII no admite un Recibo para el tipo ${d.tipoDte}.`);
      }
      if (!p.recinto?.trim()) throw new ErrorHttp(400, "RECINTO_REQUERIDO", "El recibo de la Ley 19.983 exige `recinto` (dónde se recibió).");
      xml = serializarEnvioRecibos(
        { rutResponde: c.rut, rutRecibe: d.rutContraparte, ...contacto },
        [{ ...comun, tipoDoc: d.tipoDte, recinto: p.recinto, rutFirma: firmante.rutTitular }],
        firmante,
        ahora,
      );
    }
  } catch (e) {
    if (e instanceof ErrorHttp) throw e;
    throw new ErrorHttp(422, "RESPUESTA_INVALIDA", e instanceof Error ? e.message : String(e));
  }
  await auditar(actor, "respuesta.generada", { documentoId: d.id, tipo: p.tipo, estado: p.estado ?? null }, c.id);
  const nombre = `${p.tipo === "recibo" ? "EnvioRecibos" : "RespuestaDTE"}_${d.rutContraparte}_T${d.tipoDte}F${d.folio}.xml`;
  return { xml, nombre };
}
