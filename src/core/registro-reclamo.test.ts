import { describe, expect, it } from "vitest";
import {
  clasificarAccion,
  clasificarCedible,
  eventoVigente,
  faultDe,
  parsearEventos,
  parsearFechaRecepcion,
  parsearRespuesta,
  sobreIngresarAccion,
  sobreListarEventos,
} from "./registro-reclamo";

const soap = (metodo: string, cuerpo: string) =>
  `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body>` +
  `<ns2:${metodo}Response xmlns:ns2="http://ws.registroreclamodte.diii.sdi.sii.cl">` +
  `<return>${cuerpo}</return></ns2:${metodo}Response></S:Body></S:Envelope>`;

describe("sobres del WS de registro", () => {
  it("arma ingresarAceptacionReclamoDoc con el RUT partido y la K en mayúscula", () => {
    const x = sobreIngresarAccion({ rutEmisor: "76086428-k", tipoDoc: 33, folio: 1234 }, "ACD");
    expect(x).toContain(`xmlns:ws="http://ws.registroreclamodte.diii.sdi.sii.cl"`);
    expect(x).toContain("<ws:ingresarAceptacionReclamoDoc><rutEmisor>76086428</rutEmisor><dvEmisor>K</dvEmisor>");
    expect(x).toContain("<tipoDoc>33</tipoDoc><folio>1234</folio><accionDoc>ACD</accionDoc>");
  });

  it("rechaza ANTES de salir a la red los tipos que el servicio no opera (61, 52, 39)", () => {
    for (const tipoDoc of [61, 52, 39]) {
      expect(() => sobreListarEventos({ rutEmisor: "76086428-5", tipoDoc, folio: 1 })).toThrow(/33, 34, 43/);
    }
  });

  it("rechaza una acción inventada y un RUT con formato raro (nada se interpola sin validar)", () => {
    expect(() => sobreIngresarAccion({ rutEmisor: "76086428-5", tipoDoc: 33, folio: 1 }, "XXX" as never)).toThrow(/Acción/);
    expect(() => sobreListarEventos({ rutEmisor: "76.086.428-5</rutEmisor>", tipoDoc: 33, folio: 1 })).toThrow(/RUT/);
  });
});

describe("clasificación de códigos (manual V1.1)", () => {
  it("0 registra; 7 y 19 son éxito (el evento ya está); 1..18 rechazan; −1 y desconocidos reintentan", () => {
    expect(clasificarAccion(0)).toBe("registrado");
    expect(clasificarAccion(7)).toBe("ya_estaba");
    expect(clasificarAccion(19)).toBe("ya_estaba");
    expect(clasificarAccion(8)).toBe("rechazado");
    expect(clasificarAccion(17)).toBe("rechazado");
    expect(clasificarAccion(-1)).toBe("reintentar");
    expect(clasificarAccion(99)).toBe("reintentar");
  });

  it("un reintento de reclamo que sí entró (5 'ya reclamado por' el MISMO) es ya_estaba; por otro, rechazo", () => {
    expect(clasificarAccion(5, "RCD", "DTE ya está reclamado por RCD)")).toBe("ya_estaba");
    expect(clasificarAccion(5, "RCD", "DTE ya está reclamado por RFT)")).toBe("rechazado");
    expect(clasificarAccion(5, "ACD", "DTE ya está reclamado por RCD)")).toBe("rechazado");
    expect(clasificarAccion(19, "RFT")).toBe("ya_estaba");
    expect(clasificarAccion(19, "ACD")).toBe("rechazado");
  });

  it("cedibilidad: 23/25 cedible, 20/21/24 no, 22 sin eventos", () => {
    expect(clasificarCedible(23)).toBe("cedible");
    expect(clasificarCedible(25)).toBe("cedible");
    expect(clasificarCedible(24)).toBe("no_cedible");
    expect(clasificarCedible(21)).toBe("no_cedible");
    expect(clasificarCedible(22)).toBe("sin_eventos");
    expect(clasificarCedible(18)).toBe("error");
    expect(clasificarCedible(77)).toBe("desconocido");
  });
});

describe("respuestas", () => {
  it("lee codResp/descResp de un respuestaTo", () => {
    expect(parsearRespuesta(soap("ingresarAceptacionReclamoDoc", "<codResp>0</codResp><descResp>Accion Completada OK</descResp>"))).toEqual({
      codigo: 0,
      glosa: "Accion Completada OK",
    });
    expect(parsearRespuesta(soap("x", "<codResp>-1</codResp>"))).toMatchObject({ codigo: -1 });
  });

  it("sin codResp no inventa un código", () => {
    expect(parsearRespuesta(soap("x", "<otra>1</otra>"))).toBeNull();
  });

  it("detecta un SOAP Fault", () => {
    const f = `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><S:Fault><faultcode>S:Server</faultcode><faultstring>Internal Error</faultstring></S:Fault></S:Body></S:Envelope>`;
    expect(faultDe(f)).toBe("Internal Error");
    expect(faultDe(soap("x", "<codResp>0</codResp>"))).toBeNull();
  });

  it("lee la lista de eventos con nombres conocidos y conserva los campos crudos", () => {
    const xml = soap(
      "listarEventosHistDoc",
      "<codResp>15</codResp><descResp>Listado de eventos del documento</descResp>" +
        "<listaEventosDoc><codEvento>ERM</codEvento><descEvento>Otorga Recibo de Mercaderias</descEvento>" +
        "<rutResponsable>11598736</rutResponsable><dvResponsable>4</dvResponsable><fechaEvento>02-10-2026 10:15:00</fechaEvento></listaEventosDoc>" +
        "<listaEventosDoc><codEvento>ACD</codEvento><fechaEvento>01-10-2026 09:00:00</fechaEvento><otroCampo>x</otroCampo></listaEventosDoc>",
    );
    const ev = parsearEventos(xml);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ codigo: "ERM", rutResponsable: "11598736-4", fecha: "2026-10-02T10:15:00-03:00" });
    expect(ev[1]!.campos.otroCampo).toBe("x");
    expect(eventoVigente(ev)).toBe("ERM");
  });

  it("lee la respuesta REAL del SII (2026-10-26): un PAG del emisor no es un evento del receptor", () => {
    const real =
      `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:listarEventosHistDocResponse xmlns:ns2="http://ws.registroreclamodte.diii.sdi.sii.cl">` +
      `<return><codResp>15</codResp><descResp>Listado de eventos del documento</descResp><listaEventosDoc>` +
      `<codEvento>PAG</codEvento><descEvento>DTE Pagado al Contado</descEvento><dvResponsable>9</dvResponsable>` +
      `<fechaEvento>22-10-2026 11:43:21</fechaEvento><rutResponsable>77647092</rutResponsable></listaEventosDoc></return>` +
      `</ns2:listarEventosHistDocResponse></S:Body></S:Envelope>`;
    const ev = parsearEventos(real);
    expect(ev[0]).toMatchObject({ codigo: "PAG", descripcion: "DTE Pagado al Contado", rutResponsable: "77647092-9", fecha: "2026-10-22T11:43:21-03:00" });
    expect(eventoVigente(ev)).toBeNull();
  });

  it("un reclamo manda sobre una aceptación en el evento vigente", () => {
    expect(eventoVigente([{ codigo: "ACD" }, { codigo: "RCD" }] as never)).toBe("RCD");
    expect(eventoVigente([])).toBeNull();
  });

  it("fecha de recepción: dd-mm-aaaa hh:mm:ss en hora de Chile, con el offset del día", () => {
    expect(parsearFechaRecepcion(soap("consultarFechaRecepcionSii", "21-02-2017 19:02:03"))).toBe("2017-02-21T19:02:03-03:00");
    expect(parsearFechaRecepcion(soap("consultarFechaRecepcionSii", "15-07-2026 08:00:00"))).toBe("2026-07-15T08:00:00-04:00");
    expect(parsearFechaRecepcion(soap("consultarFechaRecepcionSii", ""))).toBeNull();
    expect(parsearFechaRecepcion(soap("consultarFechaRecepcionSii", "31-02-2026 10:00:00"))).toBeNull();
  });
});
