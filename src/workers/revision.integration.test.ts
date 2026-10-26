import { SII_PRUEBA, limpiarBase } from "../test/entorno";
import { beforeEach, describe, expect, it } from "vitest";
import { RUT_KIUBO, RUT_PROVEEDOR, cafDePrueba, certificadoDePrueba, dteDePrueba, llaveSiiDePrueba } from "../core/__fixtures__/material";
import { serializarSobre } from "../core/__fixtures__/dte-sobre";
import { prisma } from "../db";
import { ClienteSii } from "../sii/cliente";
import { pfxDePrueba } from "../test/pfx";
import { siiFalso } from "../test/sii-falso";
import { cargarCertificado } from "./certificados";
import { configurarWebhook, crearConsumidor, validarUrlWebhook, type Actor } from "./consumidores";
import { asignarCasilla, crearContribuyente } from "./contribuyentes";
import { ingresarXml } from "./documentos";
import { recibirCorreo, reprocesarCorreo } from "./intercambio";
import { importarCsv } from "./rcv";
import { MAX_ERRORES_REVISION, refrescarDocumento, revisarPendientes } from "./seguimiento";
import { usarClienteSii } from "./sii";
import { entregarPendientes, encolar } from "./webhooks";

/**
 * Regresiones de la revisión independiente del 2026-10-26: cada `describe` es un hallazgo.
 */

const CERT = certificadoDePrueba();
const CAF = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: SII_PRUEBA.privada });
/** Un CAF "inventado": firmado por una llave que NO es la del SII configurada. */
const CAF_FALSO = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: llaveSiiDePrueba().privada });
const PFX = pfxDePrueba({ clave: "clave" });

const sobre = (folio: number, caf = CAF, neto = 10_000) =>
  serializarSobre(
    [{ tipoDte: 33, xml: dteDePrueba({ folio, neto }, caf, CERT) }],
    { rutEmisor: RUT_PROVEEDOR, rutEnvia: "11598736-4", rutReceptor: RUT_KIUBO, fechaResolucion: "2014-08-22", numeroResolucion: "80" },
    CERT,
    new Date("2026-10-01T13:00:00Z"),
    "dte",
  );

let actor: Actor;
let contribuyenteId: string;
let sii: ReturnType<typeof siiFalso>;

beforeEach(async () => {
  await limpiarBase();
  sii = siiFalso();
  usarClienteSii(new ClienteSii({ fetch: sii.fetch, dormir: async () => {}, esperaBaseMs: 1, reintentos: 0 }));
  const cons = await crearConsumidor("k");
  actor = { consumidorId: cons.id, apiKeyId: null };
  await configurarWebhook(actor, "http://consumidor.test/hook");
  const c = await crearContribuyente(actor, { rut: RUT_KIUBO, ambiente: "certificacion" });
  contribuyenteId = c.id;
});

const eventos = async () => (await prisma.webhookEntrega.findMany({ orderBy: { creadoEn: "asc" } })).map((e) => e.evento);

describe("#1 un XML que no verifica no le gana a uno que sí", () => {
  it("el falso que llega DESPUÉS queda en conflicto; el verdadero se conserva", async () => {
    await ingresarXml(actor, contribuyenteId, sobre(11));
    const r = await ingresarXml(actor, contribuyenteId, sobre(11, CAF_FALSO, 99_000));
    expect(r.documentos[0]).toMatchObject({ resultado: "conflicto", verificacion: { ok: false } });
    expect(Number((await prisma.documento.findFirstOrThrow()).montoTotal)).toBe(11_900);
  });

  it("el falso que llegó PRIMERO es reemplazado por el verdadero, y alerta", async () => {
    await ingresarXml(actor, contribuyenteId, sobre(12, CAF_FALSO, 99_000));
    const r = await ingresarXml(actor, contribuyenteId, sobre(12));
    expect(r.documentos[0]!.resultado).toBe("reemplazado");
    const d = await prisma.documento.findFirstOrThrow();
    expect(Number(d.montoTotal)).toBe(11_900);
    expect((d.verificacion as { ok: boolean }).ok).toBe(true);
    expect((await eventos()).filter((e) => e === "documento.alerta").length).toBeGreaterThanOrEqual(2);
  });

  it("un XML que no verifica no pisa los montos que registró el SII (RCV)", async () => {
    await importarCsv(actor, contribuyenteId, Buffer.from(`Tipo Doc;RUT Proveedor;Folio;Monto Total\n33;${RUT_PROVEEDOR};13;11900\n`), {
      periodo: "202610",
      operacion: "COMPRA",
    });
    const r = await ingresarXml(actor, contribuyenteId, sobre(13, CAF_FALSO, 99_000));
    expect(r.documentos[0]!.resultado).toBe("completado");
    expect(r.problemas[0]).toMatch(/se conservaron los montos/);
    expect(Number((await prisma.documento.findFirstOrThrow()).montoTotal)).toBe(11_900);
  });
});

describe("#2 casillas: sólo por la casilla asignada, nunca por el RUT", () => {
  const correo = (xml: Buffer) =>
    Buffer.from(
      `From: x@p.cl\r\nSubject: DTE\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\n` +
        `Content-Type: text/xml; name="e.xml"\r\nContent-Disposition: attachment; filename="e.xml"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
        `${xml.toString("base64")}\r\n--B--\r\n`,
      "latin1",
    );

  it("sin casilla asignada queda sin_destino aunque el RUT coincida; asignarla y reprocesar lo ingresa", async () => {
    const crudo = correo(sobre(21));
    const r = await recibirCorreo(crudo, "belen@dte.kiubo.io");
    expect(r.estado).toBe("sin_destino");
    await asignarCasilla(contribuyenteId, "belen@dte.kiubo.io");
    const re = await reprocesarCorreo(r.correoId);
    expect(re).toMatchObject({ estado: "dte", contribuyenteId });
    expect(await prisma.correo.count()).toBe(1);
  });

  it("el mismo correo a DOS casillas son dos entradas; y un sin_destino que vuelve a llegar se reprocesa", async () => {
    await asignarCasilla(contribuyenteId, "belen@dte.kiubo.io");
    const crudo = correo(sobre(22));
    expect((await recibirCorreo(crudo, "otra@dte.kiubo.io")).estado).toBe("sin_destino");
    expect((await recibirCorreo(crudo, "belen@dte.kiubo.io")).estado).toBe("dte");
    expect(await prisma.correo.count()).toBe(2);
    await asignarCasilla(contribuyenteId, "otra@dte.kiubo.io");
    const otra = await recibirCorreo(crudo, "otra@dte.kiubo.io");
    expect(otra).toMatchObject({ duplicado: false, estado: "dte" });
  });
});

describe("#3 el seguimiento no muere en silencio", () => {
  it("tras demasiadas fallas se detiene y AVISA; cargar el certificado lo retoma", async () => {
    await cargarCertificado(actor, contribuyenteId, PFX, "clave");
    await ingresarXml(actor, contribuyenteId, sobre(31));
    await prisma.documento.updateMany({ data: { erroresRevision: MAX_ERRORES_REVISION - 1 } });
    usarClienteSii(new ClienteSii({ fetch: (async () => new Response("", { status: 503 })) as never, reintentos: 0, dormir: async () => {} }));
    await revisarPendientes();
    const d = await prisma.documento.findFirstOrThrow();
    expect(d.proximaRevisionEn).toBeNull();
    expect(await eventos()).toContain("documento.alerta");
    await cargarCertificado(actor, contribuyenteId, PFX, "clave");
    expect((await prisma.documento.findFirstOrThrow()).proximaRevisionEn).not.toBeNull();
  });

  it("lo que ya se trajo del SII se guarda aunque un paso posterior falle", async () => {
    await cargarCertificado(actor, contribuyenteId, PFX, "clave");
    await ingresarXml(actor, contribuyenteId, sobre(32));
    const base = siiFalso();
    usarClienteSii(
      new ClienteSii({
        fetch: (async (url: string, init: RequestInit) => (url.includes("QueryEstDte") ? new Response("", { status: 503 }) : base.fetch(url, init))) as never,
        reintentos: 0,
        dormir: async () => {},
      }),
    );
    const d = await prisma.documento.findFirstOrThrow({ include: { contribuyente: true } });
    const { contribuyente, ...doc } = d;
    await expect(refrescarDocumento(contribuyente, doc)).rejects.toThrow(/503/);
    expect((await prisma.documento.findFirstOrThrow()).fechaRecepcionSii).not.toBeNull();
  });

  it("esperando al SII, el backoff crece de verdad (no se reinicia en cada revisión)", async () => {
    await cargarCertificado(actor, contribuyenteId, PFX, "clave");
    sii.estado.fechaRecepcion = null;
    await ingresarXml(actor, contribuyenteId, sobre(33));
    const t0 = new Date("2026-10-02T00:00:00Z");
    const esperas: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await prisma.documento.findFirstOrThrow({ include: { contribuyente: true } });
      const { contribuyente, ...doc } = d;
      const nuevo = await refrescarDocumento(contribuyente, doc, t0);
      esperas.push((nuevo.proximaRevisionEn!.getTime() - t0.getTime()) / 3_600_000);
    }
    expect(esperas).toEqual([1, 2, 4]);
  });
});

describe("#4 el RCV dice si hubo reclamo o acuse", () => {
  it("RECLAMADO y fecha de acuse sacan al documento de los pendientes y de los avisos", async () => {
    await importarCsv(
      actor,
      contribuyenteId,
      Buffer.from(
        `Tipo Doc;RUT Proveedor;Folio;Fecha Recepcion;Fecha Acuse;Monto Total\n` +
          `33;${RUT_PROVEEDOR};41;01/10/2026 10:00:00;;100\n33;${RUT_PROVEEDOR};42;01/10/2026 10:00:00;02/10/2026 10:00:00;100\n`,
      ),
      { periodo: "202610", operacion: "COMPRA", estado: "RECLAMADO" },
    );
    const docs = await prisma.documento.findMany({ orderBy: { folio: "asc" } });
    expect(docs.map((d) => d.eventoReceptor)).toEqual(["RECLAMADO", "RECLAMADO"]);
    await importarCsv(actor, contribuyenteId, Buffer.from(`Tipo Doc;RUT Proveedor;Folio;Fecha Acuse;Monto Total\n33;${RUT_PROVEEDOR};43;02/10/2026 10:00:00;100\n`), {
      periodo: "202610",
      operacion: "COMPRA",
    });
    expect((await prisma.documento.findFirstOrThrow({ where: { folio: 43 } })).eventoReceptor).toBe("ACUSE");
  });
});

describe("#6 un consumidor lento no acapara la entrega de webhooks", () => {
  it("toma a lo más N por consumidor por ciclo y atiende a todos", async () => {
    const otro = await crearConsumidor("otro");
    await configurarWebhook({ consumidorId: otro.id, apiKeyId: null }, "http://otro.test/hook");
    for (let i = 0; i < 8; i++) await encolar(actor.consumidorId, "webhook.prueba", `a${i}`, {});
    await encolar(otro.id, "webhook.prueba", "b0", {});
    const destinos: string[] = [];
    const n = await entregarPendientes({ porConsumidor: 3, fetch: (async (u: string) => (destinos.push(u), new Response("ok"))) as never });
    expect(n).toBe(4);
    expect(destinos.filter((u) => u.includes("otro.test"))).toHaveLength(1);
  });
});

describe("#7 la URL del webhook no se salta con trucos de host", () => {
  it("rechaza IPv4 mapeada, :: y localhost con punto final", () => {
    for (const url of ["https://[::ffff:127.0.0.1]/", "https://[::]/", "https://localhost./", "https://169.254.169.254/", "https://u:p@hooks.kiubo.io/"]) {
      expect(() => validarUrlWebhook(url, false), url).toThrow();
    }
    expect(validarUrlWebhook("https://hooks.kiubo.io/rcv", false)).toBe("https://hooks.kiubo.io/rcv");
  });
});

describe("#9 el CSV no se cae por una fila mala y es todo o nada", () => {
  it("un folio fuera de INTEGER es un problema de su línea", async () => {
    const r = await importarCsv(actor, contribuyenteId, Buffer.from(`Tipo Doc;RUT Proveedor;Folio\n33;${RUT_PROVEEDOR};99999999999\n33;${RUT_PROVEEDOR};5\n`), {
      periodo: "202610",
      operacion: "COMPRA",
    });
    expect(r.importacion).toMatchObject({ filas: 1, nuevos: 1 });
    expect((r.importacion.problemas as Array<{ linea: number }>)[0]!.linea).toBe(2);
  });

  it("dos imports simultáneos del mismo archivo: uno importa, el otro lo reconoce", async () => {
    const csv = Buffer.from(`Tipo Doc;RUT Proveedor;Folio\n33;${RUT_PROVEEDOR};7\n33;${RUT_PROVEEDOR};8\n`);
    const [a, b] = await Promise.all([
      importarCsv(actor, contribuyenteId, csv, { periodo: "202610", operacion: "COMPRA" }),
      importarCsv(actor, contribuyenteId, csv, { periodo: "202610", operacion: "COMPRA" }),
    ]);
    expect([a.yaImportado, b.yaImportado].sort()).toEqual([false, true]);
    expect(await prisma.importacionRcv.count()).toBe(1);
    expect(await prisma.documento.count()).toBe(2);
  });
});

describe("#12 ingresos simultáneos del mismo DTE", () => {
  it("no dan 500: uno es nuevo y el otro duplicado", async () => {
    const x = sobre(51);
    const [a, b] = await Promise.all([ingresarXml(actor, contribuyenteId, x), ingresarXml(actor, contribuyenteId, x)]);
    expect([a.documentos[0]!.resultado, b.documentos[0]!.resultado].sort()).toEqual(["duplicado", "nuevo"]);
    expect(await prisma.documento.count()).toBe(1);
  });
});
