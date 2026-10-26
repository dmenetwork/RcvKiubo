import { SII_PRUEBA, limpiarBase } from "../test/entorno";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RUT_KIUBO, RUT_PROVEEDOR, cafDePrueba, certificadoDePrueba, dteDePrueba } from "../core/__fixtures__/material";
import { serializarSobre } from "../core/__fixtures__/dte-sobre";
import type { FilaDetalleSii, ResumenRcv } from "../core/rcv-portal";
import { prisma } from "../db";
import { ErrorSii } from "../sii/cliente";
import { pfxDePrueba } from "../test/pfx";
import { cargarCertificado } from "./certificados";
import { configurarWebhook, crearConsumidor, type Actor } from "./consumidores";
import { crearContribuyente } from "./contribuyentes";
import { ingresarXml } from "./documentos";
import { periodoActual, rcvDelPeriodo, sincronizarRcv, sincronizarTodos, usarPortalRcv, type SesionPortalRcv } from "./rcv-portal";

const CERT = certificadoDePrueba();
const CAF = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: SII_PRUEBA.privada });
const [RUT_C, RUT_DV] = RUT_PROVEEDOR.split("-") as [string, string];

const resumen = (tipoDte: number, total: number, monto: number, tieneDetalle = true): ResumenRcv => ({
  tipoDte, nombreTipoDoc: tipoDte === 39 ? "Total Oper. del mes Boleta Electr." : "Factura Electrónica", tipoIngreso: tieneDetalle ? "DET_ELE" : "RESUMEN",
  tieneDetalle, totalDocumentos: total, montoExento: 0, montoNeto: monto, montoIva: 0, montoIvaNoRecuperable: 0, ivaUsoComun: 0, montoTotal: monto,
});
const det = (folio: number, total: number, extra: Partial<FilaDetalleSii> = {}): FilaDetalleSii =>
  ({
    detTipoDoc: null, detRutDoc: Number(RUT_C), detDvDoc: RUT_DV, detRznSoc: "PROVEEDOR", detNroDoc: folio, detFchDoc: "01/10/2026",
    detFecAcuse: null, detFecReclamado: null, detFecRecepcion: "01/10/2026 10:00:00", detMntExe: 0, detMntNeto: total, detMntIVA: 0,
    detMntIVANoRec: 0, detMntCodNoRec: 0, detMntTotal: total, totalDtoiMontoImp: 0, descTipoTransaccion: "Del Giro",
    detEventoReceptor: null, detEventoReceptorLeyenda: null, detTipoDocRef: 0, detFolioDocRef: null, ...extra,
  }) as FilaDetalleSii;

/** Un portal falso con el RCV de octubre: 2 compras registradas (una llegó por XML), 1 pendiente, ventas con boletas sólo en total. */
function portalOctubre(): SesionPortalRcv & { pedidos: string[] } {
  const pedidos: string[] = [];
  return {
    pedidos,
    async resumen(_rut, _p, op, estado) {
      pedidos.push(`resumen ${op} ${estado}`);
      if (op === "COMPRA" && estado === "REGISTRO") return [resumen(33, 2, 23_800)];
      if (op === "COMPRA" && estado === "PENDIENTE") return [resumen(33, 1, 5_000)];
      if (op === "VENTA") return [resumen(39, 18_885, 1_000_000, false)];
      return [];
    },
    async detalle(_rut, _p, op, estado, tipo) {
      pedidos.push(`detalle ${op} ${estado} ${tipo}`);
      if (estado === "REGISTRO") return [det(11, 11_900, { detFecAcuse: "02/10/2026 09:00:00", detEventoReceptorLeyenda: "Recibo otorgado por el receptor" }), det(99, 11_900)];
      if (estado === "PENDIENTE") return [det(77, 5_000)];
      return [];
    },
    async cerrar() {},
  };
}

let actor: Actor;
let contribuyenteId: string;

beforeEach(async () => {
  await limpiarBase();
  usarPortalRcv(async () => portalOctubre());
  const cons = await crearConsumidor("k");
  actor = { consumidorId: cons.id, apiKeyId: null };
  await configurarWebhook(actor, "http://consumidor.test/hook");
  const c = await crearContribuyente(actor, { rut: RUT_KIUBO, ambiente: "certificacion", razonSocial: "SOCIEDAD G Y A" });
  contribuyenteId = c.id;
});
afterAll(() => usarPortalRcv(null));

describe("sincronización del RCV desde el portal", () => {
  it("guarda el resumen como el SII y el detalle como documentos, sin pisar el XML", async () => {
    await ingresarXml(
      actor,
      contribuyenteId,
      serializarSobre(
        [{ tipoDte: 33, xml: dteDePrueba({ folio: 11 }, CAF, CERT) }],
        { rutEmisor: RUT_PROVEEDOR, rutEnvia: "11598736-4", rutReceptor: RUT_KIUBO, fechaResolucion: "2014-08-22", numeroResolucion: "80" },
        CERT,
        new Date("2026-10-01T13:00:00Z"),
        "dte",
      ),
    );
    const c = await prisma.contribuyente.findUniqueOrThrow({ where: { id: contribuyenteId } });
    const s = await sincronizarRcv(c, "202610");
    expect(s).toMatchObject({ estado: "ok", documentos: 3, nuevos: 2, actualizados: 1 });

    expect(await prisma.rcvResumen.count()).toBe(3);
    const d11 = await prisma.documento.findFirstOrThrow({ where: { folio: 11 } });
    expect(d11).toMatchObject({ enXml: true, enRcv: true, estadoRcv: "REGISTRO", eventoReceptor: "ACUSE" });
    expect(Number(d11.montoTotal)).toBe(11_900);
    expect((await prisma.documento.findFirstOrThrow({ where: { folio: 77 } })).estadoRcv).toBe("PENDIENTE");

    const v = await rcvDelPeriodo(actor, contribuyenteId, "202610");
    const registro = v.secciones.find((x) => x.operacion === "COMPRA" && x.estado === "REGISTRO")!;
    expect(registro.resumen[0]).toMatchObject({ tipoDte: 33, totalDocumentos: 2 });
    expect(registro.detalle.map((x) => [x.folio, x.enXml, x.evento])).toEqual(
      expect.arrayContaining([[11, true, "Recibo otorgado por el receptor"], [99, false, null]]),
    );
    const ventas = v.secciones.find((x) => x.operacion === "VENTA")!;
    expect(ventas.resumen[0]).toMatchObject({ tipoDte: 39, tieneDetalle: false, totalDocumentos: 18_885 });
    expect((await prisma.webhookEntrega.findFirstOrThrow({ where: { evento: "rcv.sincronizado" } })).payload).toMatchObject({
      datos: { documentos: 3, comprasSinXml: 2 },
    });
  });

  it("no pide el detalle de lo que el SII da sólo como total (boletas)", async () => {
    const portal = portalOctubre();
    usarPortalRcv(async () => portal);
    await sincronizarRcv(await prisma.contribuyente.findUniqueOrThrow({ where: { id: contribuyenteId } }), "202610");
    expect(portal.pedidos.filter((p) => p.startsWith("detalle VENTA"))).toEqual([]);
  });

  it("si el SII pide captcha: queda registrado, avisa y no guarda nada a medias", async () => {
    usarPortalRcv(async () => ({
      ...portalOctubre(),
      async detalle() {
        throw new ErrorSii("SII_CAPTCHA", "captcha", false);
      },
    }));
    const c = await prisma.contribuyente.findUniqueOrThrow({ where: { id: contribuyenteId } });
    await expect(sincronizarRcv(c, "202610")).rejects.toMatchObject({ codigo: "SII_CAPTCHA" });
    expect(await prisma.sincronizacionRcv.findFirstOrThrow()).toMatchObject({ estado: "captcha" });
    expect(await prisma.rcvResumen.count()).toBe(0);
    expect(await prisma.documento.count()).toBe(0);
    expect((await prisma.webhookEntrega.findFirstOrThrow()).evento).toBe("rcv.sincronizacion_fallida");
  });

  it("el job sincroniza sólo a quien tiene certificado: mes actual y, hasta el día 20, el anterior", async () => {
    const portal = portalOctubre();
    usarPortalRcv(async () => portal);
    expect(await sincronizarTodos(new Date("2026-10-15T15:00:00Z"))).toEqual({ ok: 0, errores: 0 });
    await cargarCertificado(actor, contribuyenteId, pfxDePrueba({ clave: "x" }), "x");
    expect(await sincronizarTodos(new Date("2026-10-15T15:00:00Z"))).toEqual({ ok: 2, errores: 0 });
    expect((await prisma.sincronizacionRcv.findMany()).map((s) => s.periodo).sort()).toEqual(["202609", "202610"]);
    expect(await sincronizarTodos(new Date("2026-10-25T15:00:00Z"))).toEqual({ ok: 1, errores: 0 });
  });

  it("período en hora de Chile", () => {
    expect(periodoActual(new Date("2026-11-01T02:00:00Z"))).toBe("202610"); // 23:00 del 31-10 en Chile
    expect(periodoActual(new Date("2026-01-15T12:00:00Z"), 1)).toBe("202512");
  });
});
