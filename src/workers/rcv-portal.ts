import { esPeriodo, siiTimestamp, ymdSantiago } from "../core/fechas";
import { detalleDesdeFila, type SeccionVista } from "../core/rcv-formato";
import { ESTADOS_COMPRA, filaDesdePortal, type FilaDetalleSii, type ResumenRcv } from "../core/rcv-portal";
import type { EstadoRcv, FilaRcv, OperacionRcv } from "../core/rcv-csv";
import { prisma } from "../db";
import { ErrorHttp } from "../errores";
import type { Contribuyente, Prisma } from "../generated/prisma/client";
import { log } from "../log";
import { ErrorSii } from "../sii/cliente";
import { SesionRcv } from "../sii/portal";
import { firmanteDe } from "./certificados";
import type { Actor } from "./consumidores";
import { contribuyenteDe } from "./contribuyentes";
import { upsertFila } from "./rcv";
import { encolar } from "./webhooks";

/**
 * Sincronización del RCV desde el portal del SII: el resumen (la "primera pantalla" del registro) y el
 * detalle de cada tipo de documento, de compras en sus cuatro estados y de ventas.
 *
 * Primero se BAJA todo (red), después se GUARDA todo en una transacción: un corte a mitad de la bajada
 * no deja un período a medias. El detalle entra por el mismo `upsertFila` que el CSV, así que lo que
 * llegó por XML conserva sus montos firmados y el RCV completa el resto.
 */

/** Lo que se usa de una sesión del portal: inyectable en los tests. */
export interface SesionPortalRcv {
  resumen(rutEmpresa: string, periodo: string, operacion: OperacionRcv, estado: EstadoRcv): Promise<ResumenRcv[]>;
  detalle(rutEmpresa: string, periodo: string, operacion: OperacionRcv, estado: EstadoRcv | "", tipoDte: number): Promise<FilaDetalleSii[]>;
  cerrar(): Promise<void>;
}

export type AbrirSesion = (contribuyenteId: string) => Promise<SesionPortalRcv>;

const abrirReal: AbrirSesion = async (contribuyenteId) => {
  const f = await firmanteDe(contribuyenteId);
  return SesionRcv.abrir(f, f.rutTitular);
};
let abrirSesion = abrirReal;

/** Sólo tests: un portal falso. */
export function usarPortalRcv(a: AbrirSesion | null): void {
  abrirSesion = a ?? abrirReal;
}

interface Bajada {
  resumenes: Array<ResumenRcv & { operacion: OperacionRcv; estado: EstadoRcv }>;
  detalles: Array<{ operacion: OperacionRcv; estado: EstadoRcv | null; fila: FilaRcv }>;
  problemas: string[];
}

async function bajar(s: SesionPortalRcv, rut: string, periodo: string): Promise<Bajada> {
  const b: Bajada = { resumenes: [], detalles: [], problemas: [] };
  const pedidos: Array<{ operacion: OperacionRcv; estado: EstadoRcv }> = [
    ...ESTADOS_COMPRA.map((estado) => ({ operacion: "COMPRA" as const, estado })),
    { operacion: "VENTA", estado: "REGISTRO" },
  ];
  for (const { operacion, estado } of pedidos) {
    for (const r of await s.resumen(rut, periodo, operacion, estado)) {
      b.resumenes.push({ ...r, operacion, estado });
      if (!r.tieneDetalle || r.totalDocumentos === 0) continue;
      // Ventas no tiene estados: el detalle se pide con estado vacío (así lo hace el portal).
      const filas = await s.detalle(rut, periodo, operacion, operacion === "COMPRA" ? estado : "", r.tipoDte);
      filas.forEach((f, i) => {
        const fila = filaDesdePortal(f, r.tipoDte, i + 1);
        if (typeof fila === "string") b.problemas.push(`${operacion} ${estado} tipo ${r.tipoDte} fila ${i + 1}: ${fila}`);
        else b.detalles.push({ operacion, estado: operacion === "COMPRA" ? estado : null, fila });
      });
      if (filas.length !== r.totalDocumentos) {
        b.problemas.push(`${operacion} ${estado} tipo ${r.tipoDte}: el resumen dice ${r.totalDocumentos} documentos y el detalle trajo ${filas.length}`);
      }
    }
  }
  return b;
}

export async function sincronizarRcv(c: Contribuyente, periodo: string, ahora = new Date()) {
  if (!esPeriodo(periodo)) throw new ErrorHttp(400, "PERIODO_INVALIDO", "El período va como AAAAMM.");
  const sinc = await prisma.sincronizacionRcv.create({ data: { contribuyenteId: c.id, periodo, estado: "en_curso", iniciadaEn: ahora } });
  let sesion: SesionPortalRcv | null = null;
  try {
    sesion = await abrirSesion(c.id);
    const b = await bajar(sesion, c.rut, periodo);

    const r = await prisma.$transaction(
      async (tx) => {
        // El resumen se reemplaza entero: lo que dice el SII ahora es la verdad del período.
        await tx.rcvResumen.deleteMany({ where: { contribuyenteId: c.id, periodo } });
        await tx.rcvResumen.createMany({
          data: b.resumenes.map((x) => ({
            contribuyenteId: c.id,
            periodo,
            operacion: x.operacion,
            estadoRcv: x.estado,
            tipoDte: x.tipoDte,
            nombreTipoDoc: x.nombreTipoDoc,
            tipoIngreso: x.tipoIngreso,
            tieneDetalle: x.tieneDetalle,
            totalDocumentos: x.totalDocumentos,
            montoExento: BigInt(x.montoExento),
            montoNeto: BigInt(x.montoNeto),
            montoIva: BigInt(x.montoIva),
            montoIvaNoRecuperable: BigInt(x.montoIvaNoRecuperable),
            ivaUsoComun: BigInt(x.ivaUsoComun),
            montoTotal: BigInt(x.montoTotal),
            sincronizadoEn: ahora,
          })),
        });
        let nuevos = 0;
        for (const d of b.detalles) if ((await upsertFila(tx, c.id, d.operacion, periodo, d.estado, d.fila)).nuevo) nuevos++;
        const faltanXml = await tx.documento.count({ where: { contribuyenteId: c.id, operacion: "COMPRA", periodoRcv: periodo, enRcv: true, enXml: false } });
        const fin = await tx.sincronizacionRcv.update({
          where: { id: sinc.id },
          data: {
            estado: "ok",
            documentos: b.detalles.length,
            nuevos,
            actualizados: b.detalles.length - nuevos,
            problemas: b.problemas as unknown as Prisma.InputJsonValue,
            terminadaEn: new Date(),
          },
        });
        await encolar(
          c.consumidorId,
          "rcv.sincronizado",
          sinc.id,
          { contribuyenteId: c.id, periodo, documentos: b.detalles.length, nuevos, comprasSinXml: faltanXml, problemas: b.problemas.length },
          tx,
        );
        return fin;
      },
      { timeout: 5 * 60_000, maxWait: 30_000 },
    );
    return r;
  } catch (e) {
    const captcha = e instanceof ErrorSii && e.codigo === "SII_CAPTCHA";
    const mensaje = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    await prisma.$transaction(async (tx) => {
      await tx.sincronizacionRcv.update({ where: { id: sinc.id }, data: { estado: captcha ? "captcha" : "error", error: mensaje, terminadaEn: new Date() } });
      await encolar(c.consumidorId, "rcv.sincronizacion_fallida", sinc.id, { contribuyenteId: c.id, periodo, motivo: captcha ? "captcha" : "error", error: mensaje }, tx);
    });
    throw e;
  } finally {
    await sesion?.cerrar();
  }
}

export async function sincronizarRcvPedido(actor: Actor, contribuyenteId: string, periodo: string) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  return sincronizarRcv(c, periodo);
}

/** Período tributario (`AAAAMM`) de un instante, en hora de Chile. */
export function periodoActual(ahora: Date, mesesAtras = 0): string {
  const [a, m] = ymdSantiago(ahora).split("-").map(Number) as [number, number];
  const total = a * 12 + (m - 1) - mesesAtras;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, "0")}`;
}

/**
 * El job: para cada contribuyente con certificado y la sincronización prendida, el mes en curso y,
 * hasta el día 20 (cuando todavía entran documentos y se declara el IVA), también el anterior.
 * Un contribuyente que falla no frena a los demás.
 */
export async function sincronizarTodos(ahora = new Date()): Promise<{ ok: number; errores: number }> {
  const cs = await prisma.contribuyente.findMany({ where: { activo: true, sincronizarRcv: true, certificado: { isNot: null } } });
  const dia = Number(ymdSantiago(ahora).slice(8, 10));
  let ok = 0;
  let errores = 0;
  for (const c of cs) {
    for (const periodo of dia <= 20 ? [periodoActual(ahora), periodoActual(ahora, 1)] : [periodoActual(ahora)]) {
      try {
        await sincronizarRcv(c, periodo, ahora);
        ok++;
      } catch (e) {
        errores++;
        log.warn("sincronización del RCV falló", { contribuyente: c.id, periodo, error: e });
        // Un captcha no se arregla con el período siguiente: corta este contribuyente.
        if (e instanceof ErrorSii && e.codigo === "SII_CAPTCHA") break;
      }
    }
  }
  return { ok, errores };
}

export async function listarSincronizaciones(actor: Actor, contribuyenteId: string) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  return prisma.sincronizacionRcv.findMany({ where: { contribuyenteId: c.id }, orderBy: { iniciadaEn: "desc" }, take: 100 });
}

/**
 * El RCV de un período como lo muestra el SII: por cada (operación, estado), su resumen y su detalle.
 * Sale de lo guardado (la última sincronización o el último CSV), no del SII en vivo.
 */
export async function rcvDelPeriodo(actor: Actor, contribuyenteId: string, periodo: string, filtro: { operacion?: OperacionRcv; estado?: EstadoRcv } = {}) {
  const c = await contribuyenteDe(actor, contribuyenteId);
  if (!esPeriodo(periodo)) throw new ErrorHttp(400, "PERIODO_INVALIDO", "El período va como AAAAMM.");
  const [resumenes, docs, ultima] = await Promise.all([
    prisma.rcvResumen.findMany({ where: { contribuyenteId: c.id, periodo }, orderBy: [{ operacion: "asc" }, { tipoDte: "asc" }] }),
    prisma.documento.findMany({ where: { contribuyenteId: c.id, periodoRcv: periodo, enRcv: true } }),
    prisma.sincronizacionRcv.findFirst({ where: { contribuyenteId: c.id, periodo, estado: "ok" }, orderBy: { iniciadaEn: "desc" } }),
  ]);
  const pedidos: Array<{ operacion: OperacionRcv; estado: EstadoRcv | null }> = [
    ...ESTADOS_COMPRA.map((estado) => ({ operacion: "COMPRA" as const, estado })),
    { operacion: "VENTA" as const, estado: null },
  ].filter((p) => (!filtro.operacion || p.operacion === filtro.operacion) && (!filtro.estado || p.estado === filtro.estado || p.operacion === "VENTA"));
  const secciones: SeccionVista[] = pedidos.map(({ operacion, estado }) => ({
    operacion,
    estado,
    resumen: resumenes
      .filter((r) => r.operacion === operacion && (operacion === "VENTA" || r.estadoRcv === estado))
      .map((r) => ({
        tipoDte: r.tipoDte,
        nombreTipoDoc: r.nombreTipoDoc,
        tieneDetalle: r.tieneDetalle,
        totalDocumentos: r.totalDocumentos,
        montoExento: Number(r.montoExento),
        montoNeto: Number(r.montoNeto),
        montoIva: Number(r.montoIva),
        montoIvaNoRecuperable: Number(r.montoIvaNoRecuperable),
        ivaUsoComun: Number(r.ivaUsoComun),
        montoTotal: Number(r.montoTotal),
      })),
    detalle: docs
      .filter((d) => d.operacion === operacion && (operacion === "VENTA" || d.estadoRcv === estado))
      .map((d) => detalleDesdeFila(d.datosRcv as unknown as FilaRcv, operacion === "COMPRA" ? d.enXml : null)),
  }));
  // Las secciones vacías de compras (sin resumen ni detalle) no se muestran, salvo el registro.
  const visibles = secciones.filter((s) => s.resumen.length || s.detalle.length || (s.operacion === "COMPRA" && s.estado === "REGISTRO") || s.operacion === "VENTA");
  return {
    contribuyente: { rut: c.rut, razonSocial: c.razonSocial },
    periodo,
    sincronizadoEn: ultima ? siiTimestamp(ultima.iniciadaEn) : null,
    secciones: visibles,
  };
}
