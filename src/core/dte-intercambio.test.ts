import { describe, expect, it } from "vitest";
import { analizarCorreo, MAX_DTE_POR_CORREO } from "./dte-intercambio";

// Lo que llega a la casilla de intercambio lo manda cualquiera: estos tests fijan que se lean TODOS los
// DTE del sobre, que las tildes en latin1 sobrevivan, que nada (acuses, spam, DTD) se tome por factura
// y que un valor que no cabe en su columna no tumbe el correo. La lectura del XML en sí está cubierta
// en dte-recepcion.test.ts.

function dte(folio: number | string, opts: { rznSoc?: string; tipo?: number; fecha?: string; rutRecep?: string } = {}): string {
  return (
    `<DTE version="1.0"><Documento ID="F${folio}T33"><Encabezado>` +
    `<IdDoc><TipoDTE>${opts.tipo ?? 33}</TipoDTE><Folio>${folio}</Folio><FchEmis>${opts.fecha ?? "2026-10-15"}</FchEmis></IdDoc>` +
    `<Emisor><RUTEmisor>76.086.428-5</RUTEmisor><RznSoc>${opts.rznSoc ?? "PROVEEDOR SPA"}</RznSoc></Emisor>` +
    `<Receptor><RUTRecep>${opts.rutRecep ?? "11598736-4"}</RUTRecep><RznSocRecep>JORGE</RznSocRecep></Receptor>` +
    `<Totales><MntNeto>1000</MntNeto><IVA>190</IVA><MntTotal>1190</MntTotal></Totales>` +
    `</Encabezado></Documento></DTE>`
  );
}

function envio(dtes: string[]): string {
  return `<?xml version="1.0" encoding="ISO-8859-1"?>\n<EnvioDTE version="1.0"><SetDTE ID="SetDoc">${dtes.join("")}</SetDTE></EnvioDTE>`;
}

/** Correo multipart/mixed con adjuntos en base64, como lo arma un ERP proveedor. */
function correo(adjuntos: Array<{ nombre: string; tipo: string; bytes: Buffer }>): Uint8Array {
  const b = "LIMITE123";
  const partes = adjuntos.map(
    (a) =>
      `--${b}\r\nContent-Type: ${a.tipo}; name="${a.nombre}"\r\nContent-Disposition: attachment; filename="${a.nombre}"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${a.bytes.toString("base64").replace(/(.{76})/g, "$1\r\n")}\r\n`,
  );
  const crudo =
    `From: Proveedor <dte@proveedor.cl>\r\nTo: belen.chonchi@dte.kiubo.io\r\nSubject: Envio DTE 33\r\n` +
    `Message-ID: <abc@proveedor.cl>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n` +
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nAdjunto factura.\r\n` +
    partes.join("") +
    `--${b}--\r\n`;
  return Buffer.from(crudo, "latin1");
}

const latin1 = (s: string) => Buffer.from(s, "latin1");
const conXml = (xml: string, nombre = "envio.xml") => correo([{ nombre, tipo: "text/xml", bytes: latin1(xml) }]);

describe("analizarCorreo", () => {
  it("lee CADA <DTE> del sobre, no solo el primero", async () => {
    const r = await analizarCorreo(conXml(envio([dte(1), dte(2), dte(3)])));
    expect(r.estado).toBe("dte");
    expect(r.documentos.map((d) => d.folio)).toEqual([1, 2, 3]);
    expect(r.documentos[0]).toMatchObject({
      rutReceptor: "11598736-4",
      rutEmisor: "76086428-5",
      tipoDte: 33,
      fechaEmision: "2026-10-15",
      montoTotal: 1190,
    });
    expect(r.remitente).toBe("dte@proveedor.cl");
    expect(r.asunto).toBe("Envio DTE 33");
    expect(r.documentos[0]!.dte.xml).toMatch(/^<DTE version="1.0">[\s\S]*<\/DTE>$/);
  });

  it("decodifica latin1: la tilde llega entera, también con el adjunto como octet-stream", async () => {
    const r = await analizarCorreo(
      correo([{ nombre: "f.xml", tipo: "application/octet-stream", bytes: latin1(envio([dte(7, { rznSoc: "PANADERÍA ÑUÑOA" })])) }]),
    );
    expect(r.documentos[0]!.razonSocialEmisor).toBe("PANADERÍA ÑUÑOA");
  });

  it("un acuse de un cliente (RespuestaDTE / EnvioRecibos) no es una factura recibida", async () => {
    for (const raizXml of ["RespuestaDTE", "EnvioRecibos"]) {
      const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><${raizXml} version="1.0"><Resultado/></${raizXml}>`;
      const r = await analizarCorreo(conXml(xml, "acuse.xml"));
      expect(r.estado).toBe("respuesta");
      expect(r.documentos).toHaveLength(0);
    }
  });

  it("sin XML (o con un .zip) queda sin_dte, sin error", async () => {
    const r = await analizarCorreo(correo([{ nombre: "facturas.zip", tipo: "application/zip", bytes: Buffer.from("PK\x03\x04") }]));
    expect(r.estado).toBe("sin_dte");
    expect(r.error).toBeNull();
  });

  it("un XML que no es DTE (otro adjunto) no es error", async () => {
    const r = await analizarCorreo(conXml(`<?xml version="1.0"?><Catalogo><Item/></Catalogo>`, "catalogo.xml"));
    expect(r.estado).toBe("sin_dte");
  });

  it("un XML con DOCTYPE/ENTITY se rechaza (no se procesa) y queda como error con el motivo", async () => {
    const xml = `<?xml version="1.0" encoding="ISO-8859-1"?><!DOCTYPE EnvioDTE [<!ENTITY x "y">]><EnvioDTE><SetDTE>${dte(9)}</SetDTE></EnvioDTE>`;
    const r = await analizarCorreo(conXml(xml, "x.xml"));
    expect(r.estado).toBe("error");
    expect(r.error).toContain("DOCTYPE");
  });

  it("un DTE con folio, tipo o RUT que no caben en su columna va a problemas, no a la base", async () => {
    const r = await analizarCorreo(
      conXml(envio([dte(1), dte("99999999999"), dte(3, { tipo: 99999999999 }), dte(4, { rutRecep: "X".repeat(40) })])),
    );
    expect(r.estado).toBe("dte");
    expect(r.documentos.map((d) => d.folio)).toEqual([1]);
    expect(r.error).toContain("RUT inválido");
  });

  it("una FchEmis que no es una fecha real queda en null (no tumba el correo)", async () => {
    const r = await analizarCorreo(conXml(envio([dte(1, { fecha: "2026-13-45" }), dte(2, { fecha: "2026-02-31" })])));
    expect(r.documentos.map((d) => d.fechaEmision)).toEqual([null, null]);
  });

  it("un EnvioDTE cuyo único DTE no tiene folio es error, con el motivo", async () => {
    const roto = dte(1).replace("<Folio>1</Folio>", "");
    const r = await analizarCorreo(conXml(envio([roto]), "roto.xml"));
    expect(r.estado).toBe("error");
    expect(r.error).toContain("roto.xml");
  });

  it(`no lee más de ${MAX_DTE_POR_CORREO} DTE por correo`, async () => {
    const dtes = Array.from({ length: MAX_DTE_POR_CORREO + 3 }, (_, i) => dte(i + 1));
    const r = await analizarCorreo(conXml(envio(dtes)));
    expect(r.documentos).toHaveLength(MAX_DTE_POR_CORREO);
    expect(r.error).toContain(`más de ${MAX_DTE_POR_CORREO} DTE`);
  });
});

describe("entrada hostil: tiempo lineal (un correo no puede congelar el proceso del POS)", () => {
  it.each([
    ["1 MB de <DTE> sin cerrar", envio([]).replace("</SetDTE>", "<DTE>".repeat(200_000) + "</SetDTE>")],
    ["un DTE con 100.000 <Folio> sin cerrar", envio([dte(1).replace("<Folio>1</Folio>", "<Folio>".repeat(100_000))])],
    ["100.000 <ImptoReten> sin cerrar", envio([dte(1).replace("<MntTotal>", "<ImptoReten>".repeat(100_000) + "<MntTotal>")])],
  ])("%s se lee en menos de 1 s", async (_caso, xml) => {
    const t = performance.now();
    await analizarCorreo(conXml(xml));
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("avalancha de <DTE></DTE> cerrados (memoria, no solo tiempo)", () => {
  it("100.000 DTE vacíos en un adjunto: se leen a lo más 500 y la lista de problemas queda topada", async () => {
    const xml = envio([]).replace("</SetDTE>", "<DTE></DTE>".repeat(100_000) + "</SetDTE>");
    const t = performance.now();
    const r = await analizarCorreo(conXml(xml));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.estado).toBe("error");
    expect(r.documentos).toHaveLength(0);
    expect(r.error).toContain(`más de ${MAX_DTE_POR_CORREO} DTE`);
    expect(r.error).toMatch(/y \d+ problema\(s\) más/);
    expect(r.error!.length).toBeLessThanOrEqual(4000);
  });

  it("el tope se reparte entre adjuntos: el segundo no se lee si el primero lo agotó", async () => {
    const lleno = envio(Array.from({ length: MAX_DTE_POR_CORREO }, (_, i) => dte(i + 1)));
    const r = await analizarCorreo(
      correo([
        { nombre: "a.xml", tipo: "text/xml", bytes: latin1(lleno) },
        { nombre: "b.xml", tipo: "text/xml", bytes: latin1(envio([dte(9999)])) },
      ]),
    );
    expect(r.documentos).toHaveLength(MAX_DTE_POR_CORREO);
    expect(r.error).toContain("b.xml: no se leyó");
  });
});

describe("correo reenviado", () => {
  const interno = (folio: number) =>
    latin1(
      `From: prov@x.cl\r\nSubject: DTE\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="I"\r\n\r\n` +
        `--I\r\nContent-Type: text/xml; name="e.xml"\r\nContent-Disposition: attachment; filename="e.xml"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${latin1(envio([dte(folio)])).toString("base64")}\r\n--I--\r\n`,
    );
  it.each(["inline", "attachment"])("un DTE dentro de un correo reenviado (%s) se lee", async (disposicion) => {
    const externo =
      `From: defontana@x.cl\r\nSubject: Fwd\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="E"\r\n\r\n` +
      `--E\r\nContent-Type: text/plain\r\n\r\nreenvio\r\n--E\r\nContent-Type: message/rfc822\r\nContent-Disposition: ${disposicion}\r\n\r\n` +
      `${interno(5).toString("latin1")}\r\n--E--\r\n`;
    const r = await analizarCorreo(latin1(externo));
    expect(r.estado).toBe("dte");
    expect(r.documentos.map((d) => d.folio)).toEqual([5]);
  });
});

describe("anidamiento y tipos de adjunto", () => {
  const envolver = (interno: string, n: number): string => {
    let m = interno;
    for (let i = 0; i < n; i++) {
      m = `From: r${i}@x.cl\r\nSubject: Fwd\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="N${i}"\r\n\r\n` +
        `--N${i}\r\nContent-Type: message/rfc822\r\n\r\n${m}\r\n--N${i}--\r\n`;
    }
    return m;
  };
  const conDte = Buffer.from(conXml(envio([dte(8)]))).toString("latin1");

  it("un DTE reenviado 3 veces se lee; a 4 niveles queda error (con su crudo), no sin_dte", async () => {
    expect((await analizarCorreo(latin1(envolver(conDte, 2)))).documentos.map((d) => d.folio)).toEqual([8]);
    const hondo = await analizarCorreo(latin1(envolver(conDte, 4)));
    expect(hondo.estado).toBe("error");
    expect(hondo.error).toContain("más de 3 niveles");
  });

  it("un .docx o un SVG no cuentan como XML", async () => {
    const r = await analizarCorreo(
      correo([
        { nombre: "planilla.docx", tipo: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: Buffer.from("PK") },
        { nombre: "logo.svg", tipo: "image/svg+xml", bytes: Buffer.from("<svg/>") },
      ]),
    );
    expect(r.estado).toBe("sin_dte");
    expect(r.error).toBeNull();
  });
});
