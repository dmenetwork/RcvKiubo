import { SII_PRUEBA, limpiarBase } from "../test/entorno";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUT_KIUBO, RUT_PROVEEDOR, cafDePrueba, certificadoDePrueba, dteDePrueba } from "../core/__fixtures__/material";
import { serializarSobre } from "../core/__fixtures__/dte-sobre";
import { verificarWebhook } from "../core/credenciales";
import { prisma } from "../db";
import { ClienteSii } from "../sii/cliente";
import { pfxDePrueba } from "../test/pfx";
import { siiFalso } from "../test/sii-falso";
import { registrarAccionDocumento } from "./acciones";
import { cargarCertificado, firmanteDe } from "./certificados";
import { abrirSecretoWebhook, configurarWebhook, crearConsumidor, type Actor } from "./consumidores";
import { asignarCasilla, crearContribuyente } from "./contribuyentes";
import { ingresarXml, listarDocumentos } from "./documentos";
import { recibirCorreo } from "./intercambio";
import { cruceConConsumidor, cruceRcv, importarCsv } from "./rcv";
import { avisarPlazos, revisarPendientes } from "./seguimiento";
import { usarClienteSii } from "./sii";
import { entregarPendientes } from "./webhooks";

const CERT = certificadoDePrueba();
const CAF = cafDePrueba({ rutEmisor: RUT_PROVEEDOR, tipoDte: 33, llaveSii: SII_PRUEBA.privada });
const PFX = pfxDePrueba({ clave: "clave" });

function sobre(folios: number[], opts: { neto?: number } = {}): Buffer {
  return serializarSobre(
    folios.map((folio) => ({ tipoDte: 33, xml: dteDePrueba({ folio, neto: opts.neto }, CAF, CERT) })),
    { rutEmisor: RUT_PROVEEDOR, rutEnvia: "11598736-4", rutReceptor: RUT_KIUBO, fechaResolucion: "2014-08-22", numeroResolucion: "80" },
    CERT,
    new Date("2026-10-01T13:00:00Z"),
    "dte",
  );
}

let actor: Actor;
let contribuyenteId: string;
let sii: ReturnType<typeof siiFalso>;

beforeAll(() => {
  if (!process.env.DATABASE_URL_TEST) throw new Error("falta DATABASE_URL_TEST");
});

beforeEach(async () => {
  await limpiarBase();
  sii = siiFalso();
  usarClienteSii(new ClienteSii({ fetch: sii.fetch, dormir: async () => {}, esperaBaseMs: 1 }));
  const cons = await crearConsumidor("kiubo-test");
  actor = { consumidorId: cons.id, apiKeyId: null };
  await configurarWebhook(actor, "http://consumidor.test/hook");
  const c = await crearContribuyente(actor, { rut: RUT_KIUBO, ambiente: "certificacion" });
  await asignarCasilla(c.id, "Belen@DTE.kiubo.io");
  contribuyenteId = c.id;
  await cargarCertificado(actor, c.id, PFX, "clave");
});

const eventos = async () => (await prisma.webhookEntrega.findMany({ orderBy: { creadoEn: "asc" } })).map((e) => e.evento);

describe("certificado sellado", () => {
  it("abre la llave sólo para SU contribuyente (el sello va atado a la fila)", async () => {
    const f = await firmanteDe(contribuyenteId);
    expect(f.rutTitular).toBe("11598736-4");
    expect(f.llavePrivadaPem).toContain("PRIVATE KEY");
    const otro = await crearContribuyente(actor, { rut: "76086428-5", ambiente: "certificacion" });
    const cert = await prisma.certificado.findUniqueOrThrow({ where: { contribuyenteId } });
    const { id: _id, contribuyenteId: _c, ...copia } = cert;
    await prisma.certificado.create({ data: { ...copia, contribuyenteId: otro.id } });
    await expect(firmanteDe(otro.id)).rejects.toThrow(/no abre/);
  });

  it("no guarda la clave del pfx ni la llave en claro", async () => {
    const cert = await prisma.certificado.findUniqueOrThrow({ where: { contribuyenteId } });
    expect(Buffer.from(cert.llaveSellada).toString("latin1")).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(await prisma.auditoria.findMany())).not.toContain("clave");
  });
});

describe("ingesta de XML recibido", () => {
  it("guarda cada DTE del sobre, verificado completo (firma, timbre y CAF contra la llave del SII)", async () => {
    const r = await ingresarXml(actor, contribuyenteId, sobre([11, 12]));
    expect(r.problemas).toEqual([]);
    expect(r.documentos.map((d) => [d.folio, d.resultado, d.verificacion.ok])).toEqual([
      [11, "nuevo", true],
      [12, "nuevo", true],
    ]);
    const d = await prisma.documento.findFirstOrThrow({ where: { folio: 11 } });
    expect(d).toMatchObject({ operacion: "COMPRA", rutContraparte: RUT_PROVEEDOR, enXml: true, enRcv: false, montoTotal: 11900n });
    expect(d.firmaDte).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(d.proximaRevisionEn).not.toBeNull();
    expect(await eventos()).toEqual(["documento.recibido", "documento.recibido"]);
  });

  it("el mismo XML otra vez es duplicado; otro XML para el mismo folio es conflicto y alerta", async () => {
    await ingresarXml(actor, contribuyenteId, sobre([11]));
    expect((await ingresarXml(actor, contribuyenteId, sobre([11]))).documentos[0]!.resultado).toBe("duplicado");
    const r = await ingresarXml(actor, contribuyenteId, sobre([11], { neto: 50_000 }));
    expect(r.documentos[0]!.resultado).toBe("conflicto");
    expect(r.problemas[0]).toMatch(/XML DISTINTO/);
    expect(Number((await prisma.documento.findFirstOrThrow({ where: { folio: 11 } })).montoTotal)).toBe(11900);
    expect(await eventos()).toContain("documento.alerta");
  });

  it("un DTE adulterado se guarda con la verificación fallida y alerta", async () => {
    const xml = sobre([13]).toString("latin1").replace("<MntNeto>10000</MntNeto>", "<MntNeto>1000</MntNeto>");
    const r = await ingresarXml(actor, contribuyenteId, Buffer.from(xml, "latin1"));
    expect(r.documentos[0]!.verificacion.ok).toBe(false);
    expect(await eventos()).toEqual(["documento.recibido", "documento.alerta"]);
  });

  it("un DTE para otro receptor no se guarda", async () => {
    const otro = await crearContribuyente(actor, { rut: "76086428-5", ambiente: "certificacion" });
    const r = await ingresarXml(actor, otro.id, sobre([14]));
    expect(r.documentos).toEqual([]);
    expect(r.problemas[0]).toMatch(/es para el receptor 77840802-3/);
  });

  it("otro consumidor no ve ni toca el contribuyente", async () => {
    const ajeno = await crearConsumidor("ajeno");
    await expect(ingresarXml({ consumidorId: ajeno.id, apiKeyId: null }, contribuyenteId, sobre([15]))).rejects.toMatchObject({ status: 404 });
  });
});

describe("correo de intercambio", () => {
  const correo = (xml: Buffer) => {
    const b = "LIM";
    return Buffer.from(
      `From: dte@proveedor.cl\r\nTo: belen@dte.kiubo.io\r\nSubject: DTE\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n` +
        `--${b}\r\nContent-Type: text/xml; name="envio.xml"\r\nContent-Disposition: attachment; filename="envio.xml"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
        `${xml.toString("base64").replace(/(.{76})/g, "$1\r\n")}\r\n--${b}--\r\n`,
      "latin1",
    );
  };

  it("enruta por la casilla (sin importar mayúsculas), ingresa y deduplica el reintento del Worker", async () => {
    const crudo = correo(sobre([21, 22]));
    const r = await recibirCorreo(crudo, "BELEN@dte.kiubo.io");
    expect(r).toMatchObject({ estado: "dte", duplicado: false, contribuyenteId });
    expect(r.ingreso!.documentos).toHaveLength(2);
    expect((await recibirCorreo(crudo, "belen@dte.kiubo.io")).duplicado).toBe(true);
    expect(await prisma.documento.count()).toBe(2);
  });

  it("sin destino conserva el crudo para reprocesarlo", async () => {
    await prisma.contribuyente.update({ where: { id: contribuyenteId }, data: { rut: "11598736-4" } });
    const r = await recibirCorreo(correo(sobre([23])), "otra@casilla.cl");
    expect(r.estado).toBe("sin_destino");
    const fila = await prisma.correo.findUniqueOrThrow({ where: { id: r.correoId } });
    expect(fila.crudo).not.toBeNull();
  });
});

describe("seguimiento contra el SII", () => {
  it("trae fecha de recepción, eventos, cedibilidad y estado; agenda la próxima revisión", async () => {
    await ingresarXml(actor, contribuyenteId, sobre([31]));
    const ahora = new Date("2026-10-02T12:00:00Z");
    await prisma.documento.updateMany({ data: { proximaRevisionEn: ahora } });
    expect(await revisarPendientes({ ahora })).toEqual({ revisados: 1, errores: 0 });
    const d = await prisma.documento.findFirstOrThrow({ where: { folio: 31 } });
    expect(d.fechaRecepcionSii!.toISOString()).toBe("2026-10-01T13:00:00.000Z");
    expect(d.plazoVence!.toISOString()).toBe("2026-10-09T13:00:00.000Z");
    expect(d).toMatchObject({ estadoSii: "DOK", claseEstadoSii: "valido", cedibilidad: "sin_eventos", eventoReceptor: null });
    // Plazo abierto sin evento: vuelve en 6 h.
    expect(d.proximaRevisionEn!.toISOString()).toBe("2026-10-02T18:00:00.000Z");
    // El estado del DTE se preguntó con el RUT del titular del certificado como consultante.
    expect(sii.llamadas.find((l) => l.url.includes("QueryEstDte"))!.cuerpo).toContain("<RutConsultante>11598736</RutConsultante>");
  });

  it("un estado malo del SII alerta", async () => {
    sii.estado.estadoDte = "ANC";
    await ingresarXml(actor, contribuyenteId, sobre([32]));
    await revisarPendientes();
    expect(await eventos()).toContain("documento.alerta");
  });

  it("una falla del SII queda anotada y con backoff, sin perder el documento", async () => {
    usarClienteSii(new ClienteSii({ fetch: (async () => new Response("", { status: 503 })) as never, reintentos: 0, dormir: async () => {} }));
    await ingresarXml(actor, contribuyenteId, sobre([33]));
    const ahora = new Date();
    expect((await revisarPendientes({ ahora })).errores).toBe(1);
    const d = await prisma.documento.findFirstOrThrow({ where: { folio: 33 } });
    expect(d.erroresRevision).toBe(1);
    expect(d.errorRevision).toMatch(/503/);
    expect(d.proximaRevisionEn!.getTime()).toBeGreaterThan(ahora.getTime());
  });
});

describe("aceptación y reclamo", () => {
  it("registra ACD, deja constancia, actualiza el evento desde el historial del SII y avisa", async () => {
    const { documentos } = await ingresarXml(actor, contribuyenteId, sobre([41]));
    const r = await registrarAccionDocumento(actor, contribuyenteId, documentos[0]!.id, "ACD");
    expect(r).toMatchObject({ codigo: 0, resultado: "registrado" });
    expect(r.documento!.sii.eventoReceptor).toBe("ACD");
    expect(r.documento!.plazo!.estado).toBe("aceptado");
    expect(await prisma.accionRegistrada.findFirstOrThrow()).toMatchObject({ accion: "ACD", codigo: 0, resultado: "registrado", folio: 41 });
    expect(await eventos()).toContain("documento.evento");
  });

  it("un rechazo del SII (8: fuera de plazo) queda registrado y no cambia el documento", async () => {
    sii.estado.codigoAccion = 8;
    const { documentos } = await ingresarXml(actor, contribuyenteId, sobre([42]));
    const r = await registrarAccionDocumento(actor, contribuyenteId, documentos[0]!.id, "RCD");
    expect(r).toMatchObject({ codigo: 8, resultado: "rechazado", documento: null });
    expect((await prisma.documento.findFirstOrThrow({ where: { folio: 42 } })).eventoReceptor).toBeNull();
  });
});

describe("plazos", () => {
  it("avisa una sola vez el plazo por vencer, y la aceptación tácita", async () => {
    await ingresarXml(actor, contribuyenteId, sobre([51, 52]));
    const ahora = new Date("2026-10-08T12:00:00Z");
    await prisma.documento.updateMany({ where: { folio: 51 }, data: { plazoVence: new Date("2026-10-09T12:00:00Z") } });
    await prisma.documento.updateMany({ where: { folio: 52 }, data: { plazoVence: new Date("2026-10-07T12:00:00Z") } });
    // Con la última revisión contra el SII todavía pendiente, la tácita NO se declara: un evento de
    // las últimas horas no puede terminar avisado como tácito.
    expect(await avisarPlazos(ahora)).toBe(1);
    await prisma.documento.updateMany({ where: { folio: 52 }, data: { proximaRevisionEn: null } });
    expect(await avisarPlazos(ahora)).toBe(1);
    expect(await avisarPlazos(ahora)).toBe(0);
    const ev = await eventos();
    expect(ev.filter((e) => e === "documento.plazo_por_vencer")).toHaveLength(1);
    expect(ev.filter((e) => e === "documento.aceptado_tacito")).toHaveLength(1);
  });
});

describe("RCV", () => {
  const csv = (filas: string[]) =>
    Buffer.from(
      ["Nro;Tipo Doc;Tipo Compra;RUT Proveedor;Razon Social;Folio;Fecha Docto;Fecha Recepcion;Fecha Acuse;Monto Exento;Monto Neto;Monto IVA Recuperable;Monto Total", ...filas].join("\n"),
      "latin1",
    );

  it("completa lo que llegó por XML, crea lo que falta y lo informa; re-importar es idempotente", async () => {
    await ingresarXml(actor, contribuyenteId, sobre([61]));
    const archivo = csv([
      `1;33;Del Giro;${RUT_PROVEEDOR};PROVEEDOR;61;01/10/2026;01/10/2026 10:00:00;;0;10000;1900;11900`,
      `2;33;Del Giro;${RUT_PROVEEDOR};PROVEEDOR;62;02/10/2026;02/10/2026 11:00:00;;0;5000;950;5950`,
    ]);
    const r = await importarCsv(actor, contribuyenteId, archivo, { nombreArchivo: `RCV_COMPRA_REGISTRO_${RUT_KIUBO}_202610.csv` });
    expect(r.importacion).toMatchObject({ operacion: "COMPRA", periodo: "202610", estadoRcv: "REGISTRO", nuevos: 1, actualizados: 1 });
    expect(r.faltantesXml.map((d) => (d as { folio: number }).folio)).toEqual([62]);
    const d62 = await prisma.documento.findFirstOrThrow({ where: { folio: 62 } });
    expect(d62.plazoVence!.toISOString()).toBe("2026-10-10T14:00:00.000Z");
    expect((await importarCsv(actor, contribuyenteId, archivo, { nombreArchivo: `RCV_COMPRA_REGISTRO_${RUT_KIUBO}_202610.csv` })).yaImportado).toBe(true);
    expect(await eventos()).toContain("rcv.importado");
  });

  it("rechaza un CSV de otro RUT", async () => {
    await expect(importarCsv(actor, contribuyenteId, csv([]), { nombreArchivo: "RCV_COMPRA_REGISTRO_76086428-5_202610.csv" })).rejects.toMatchObject({
      codigo: "RCV_DE_OTRO_RUT",
    });
  });

  it("cruce del período y cruce contra la lista del consumidor", async () => {
    await ingresarXml(actor, contribuyenteId, sobre([71, 72]));
    await importarCsv(
      actor,
      contribuyenteId,
      csv([
        `1;33;Del Giro;${RUT_PROVEEDOR};P;71;01/10/2026;01/10/2026 10:00:00;;0;10000;1900;99999`,
        `2;33;Del Giro;${RUT_PROVEEDOR};P;73;01/10/2026;01/10/2026 10:00:00;;0;10000;1900;11900`,
      ]),
      { periodo: "202610", operacion: "COMPRA" },
    );
    const c = await cruceRcv(actor, contribuyenteId, "202610");
    expect(c.totales).toEqual({ documentos: 3, enAmbos: 1, faltaXml: 1, faltaEnRcv: 1, montoDistinto: 1 });

    const k = await cruceConConsumidor(actor, contribuyenteId, {
      operacion: "COMPRA",
      periodo: "202610",
      documentos: [
        { rutContraparte: "76.086.428-5", tipoDte: 33, folio: 71, montoTotal: 11900 },
        { rutContraparte: RUT_PROVEEDOR, tipoDte: 33, folio: 999 },
      ],
    });
    expect(k.totales).toMatchObject({ coinciden: 1, faltanEnConsumidor: 1, faltanEnServicio: 1 });
  });

  it("los filtros de documentos: sólo en RCV y pendientes", async () => {
    await ingresarXml(actor, contribuyenteId, sobre([81]));
    await importarCsv(actor, contribuyenteId, csv([`1;33;X;${RUT_PROVEEDOR};P;82;01/10/2026;;;0;1;0;1`]), { periodo: "202610", operacion: "COMPRA" });
    expect((await listarDocumentos(actor, contribuyenteId, { soloRcv: true })).documentos.map((d) => d.folio)).toEqual([82]);
    expect((await listarDocumentos(actor, contribuyenteId, { pendientes: true })).documentos).toHaveLength(2);
  });
});

describe("webhooks", () => {
  it("entrega firmado, y ante una falla reintenta con backoff", async () => {
    await ingresarXml(actor, contribuyenteId, sobre([91]));
    const recibidos: Array<{ firma: string; cuerpo: string }> = [];
    const ok = (async (_u: string, init: RequestInit) => {
      recibidos.push({ firma: (init.headers as Record<string, string>)["X-RcvKiubo-Firma"]!, cuerpo: String(init.body) });
      return new Response("ok");
    }) as never;
    expect(await entregarPendientes({ fetch: ok })).toBe(1);
    const consumidor = await prisma.consumidor.findUniqueOrThrow({ where: { id: actor.consumidorId } });
    const secreto = abrirSecretoWebhook(actor.consumidorId, consumidor.webhookSecretoSellado!);
    expect(verificarWebhook(recibidos[0]!.firma, secreto, recibidos[0]!.cuerpo, new Date())).toBe(true);
    expect(JSON.parse(recibidos[0]!.cuerpo)).toMatchObject({ evento: "documento.recibido", datos: { documento: { folio: 91 } } });
    expect((await prisma.webhookEntrega.findFirstOrThrow()).estado).toBe("entregado");

    await ingresarXml(actor, contribuyenteId, sobre([92]));
    const ahora = new Date();
    await entregarPendientes({ ahora, fetch: (async () => new Response("caído", { status: 500 })) as never });
    const e = await prisma.webhookEntrega.findFirstOrThrow({ where: { estado: "pendiente" } });
    expect(e).toMatchObject({ intentos: 1, ultimoStatus: 500 });
    expect(e.proximoIntentoEn.getTime()).toBe(ahora.getTime() + 60_000);
  });
});
