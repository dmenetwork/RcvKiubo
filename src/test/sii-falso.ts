/**
 * Un SII falso para los tests: responde por servicio y por método, y registra cada llamada.
 * Las respuestas tienen la forma de los manuales del SII (ver `core/registro-reclamo.ts` y
 * `core/estado-dte.ts`).
 */

export interface EstadoSiiFalso {
  fechaRecepcion: string | null;
  /** Lista de eventos (`codEvento`) que devuelve listarEventosHistDoc; vacía → 16. */
  eventos: Array<{ codigo: string; fecha: string }>;
  codigoCedible: number;
  estadoDte: string;
  /** Código que responde ingresarAceptacionReclamoDoc. */
  codigoAccion: number;
}

export function siiFalso(inicial: Partial<EstadoSiiFalso> = {}) {
  const estado: EstadoSiiFalso = {
    fechaRecepcion: "01-10-2026 10:00:00",
    eventos: [],
    codigoCedible: 22,
    estadoDte: "DOK",
    codigoAccion: 0,
    ...inicial,
  };
  const llamadas: Array<{ url: string; cuerpo: string }> = [];
  const soap = (cuerpo: string) =>
    `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/"><S:Body><ns2:r xmlns:ns2="http://ws.registroreclamodte.diii.sdi.sii.cl"><return>${cuerpo}</return></ns2:r></S:Body></S:Envelope>`;

  const fetch = (async (url: string, init: RequestInit) => {
    const cuerpo = String(init.body ?? "");
    llamadas.push({ url, cuerpo });
    let body: string;
    if (url.includes("CrSeed.jws")) body = `<x>&lt;SEMILLA&gt;012345678&lt;/SEMILLA&gt;</x>`;
    else if (url.includes("GetTokenFromSeed.jws")) body = `<x>&lt;TOKEN&gt;TOKENFALSO&lt;/TOKEN&gt;</x>`;
    else if (url.includes("QueryEstDte")) body = `<r>&lt;ESTADO&gt;${estado.estadoDte}&lt;/ESTADO&gt;&lt;GLOSA&gt;DTE Recibido&lt;/GLOSA&gt;</r>`;
    else if (url.includes("registroreclamodteservice")) {
      if (cuerpo.includes("consultarFechaRecepcionSii")) body = soap(estado.fechaRecepcion ?? "");
      else if (cuerpo.includes("listarEventosHistDoc")) {
        body = estado.eventos.length
          ? soap(`<codResp>15</codResp><descResp>Listado</descResp>${estado.eventos.map((e) => `<listaEventosDoc><codEvento>${e.codigo}</codEvento><fechaEvento>${e.fecha}</fechaEvento></listaEventosDoc>`).join("")}`)
          : soap(`<codResp>16</codResp><descResp>Sin eventos</descResp>`);
      } else if (cuerpo.includes("consultarDocDteCedible")) body = soap(`<codResp>${estado.codigoCedible}</codResp>`);
      else if (cuerpo.includes("ingresarAceptacionReclamoDoc")) {
        body = soap(`<codResp>${estado.codigoAccion}</codResp><descResp>respuesta</descResp>`);
        const accion = /<accionDoc>(\w+)<\/accionDoc>/.exec(cuerpo)?.[1];
        if (estado.codigoAccion === 0 && accion) estado.eventos.push({ codigo: accion, fecha: "02-10-2026 09:00:00" });
      } else body = soap("<codResp>99</codResp>");
    } else if (url.includes("ee_empresa_rut")) body = "<html>no corresponde a una empresa autorizada</html>";
    else throw new Error(`SII falso: ruta no simulada ${url}`);
    return new Response(body, { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  return { estado, llamadas, fetch };
}
