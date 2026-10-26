import { describe, expect, it } from "vitest";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import {
  baseSii,
  construirGetToken,
  envioAceptado,
  extraerEstadoEnvio,
  extraerSemilla,
  extraerToken,
  extraerTrackId,
} from "./dte-token";
import { digestioSha1, signedInfoCanonico } from "./dte-firma";

const b64 = (s: string) => Buffer.from(s, "base64url").toString("base64");

function certificadoDePrueba() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return {
    llavePrivadaPem: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
    modulus: b64(jwk.n),
    exponent: b64(jwk.e),
    x509: "MIIB",
  };
}

describe("construirGetToken", () => {
  it("firma el documento entero: la referencia va VACÍA, no #id", () => {
    const xml = construirGetToken("012345678", certificadoDePrueba());
    expect(xml).toContain('<Reference URI="">');
    expect(xml).not.toContain('URI="#');
  });

  it("la firma verifica contra la llave que el propio documento publica", () => {
    const cert = certificadoDePrueba();
    const xml = construirGetToken("012345678", cert);

    // El digest es sobre la semilla SIN la firma: eso es lo que exige enveloped-signature.
    const sinFirma = "<getToken><item><Semilla>012345678</Semilla></item></getToken>";
    const sig = xml.match(/<SignatureValue>([^<]*)<\/SignatureValue>/)![1];

    const pub = createPublicKey({
      key: {
        kty: "RSA",
        n: cert.modulus.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        e: cert.exponent.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      },
      format: "jwk",
    });
    const v = createVerify("RSA-SHA1");
    v.update(Buffer.from(signedInfoCanonico("", digestioSha1(sinFirma)), "utf8"));
    expect(v.verify(pub, Buffer.from(sig, "base64"))).toBe(true);
  });

  it("conserva la semilla tal cual dentro del documento firmado", () => {
    const xml = construirGetToken(" 987654321 ", certificadoDePrueba());
    expect(xml).toContain("<Semilla>987654321</Semilla>");
  });

  it("rechaza una semilla que no es numérica en vez de firmar basura", () => {
    // Pasa cuando la respuesta de CrSeed no se pudo interpretar: firmar igual produciría un token
    // inválido y un diagnóstico imposible.
    expect(() => construirGetToken("<html>error", certificadoDePrueba())).toThrow(/no es numérica/);
    expect(() => construirGetToken("", certificadoDePrueba())).toThrow(/no es numérica/);
  });
});

describe("lectura de las respuestas del SII", () => {
  it("saca la semilla de un SOAP con el XML escapado adentro", () => {
    const soap =
      `<soapenv:Envelope><soapenv:Body><getSeedResponse><getSeedReturn>` +
      `&lt;?xml version="1.0"?&gt;&lt;SII:RESPUESTA&gt;&lt;SII:RESP_BODY&gt;` +
      `&lt;SEMILLA&gt;043330183166&lt;/SEMILLA&gt;` +
      `&lt;/SII:RESP_BODY&gt;&lt;/SII:RESPUESTA&gt;` +
      `</getSeedReturn></getSeedResponse></soapenv:Body></soapenv:Envelope>`;
    expect(extraerSemilla(soap)).toBe("043330183166");
  });

  it("saca el token", () => {
    expect(extraerToken("&lt;TOKEN&gt;A1B2C3D4E5&lt;/TOKEN&gt;")).toBe("A1B2C3D4E5");
  });

  it("saca el trackid de la respuesta de subida", () => {
    expect(extraerTrackId("<RECEPCIONDTE><TRACKID>1234567890</TRACKID></RECEPCIONDTE>")).toBe(
      "1234567890",
    );
  });

  it("devuelve null en vez de inventar cuando la respuesta no trae lo esperado", () => {
    expect(extraerSemilla("<html>502 Bad Gateway</html>")).toBeNull();
    expect(extraerToken("")).toBeNull();
    expect(extraerTrackId("<RECEPCIONDTE><ESTADO>3</ESTADO></RECEPCIONDTE>")).toBeNull();
  });
});

describe("estado del envío ante el SII", () => {
  const respuesta = (cuerpo: string) =>
    `<soapenv:Envelope><soapenv:Body><getEstUpResponse><getEstUpReturn>` +
    cuerpo.replace(/</g, "&lt;").replace(/>/g, "&gt;") +
    `</getEstUpReturn></getEstUpResponse></soapenv:Body></soapenv:Envelope>`;

  it("lee un envío procesado y aceptado", () => {
    const e = extraerEstadoEnvio(
      respuesta("<ESTADO>EPR</ESTADO><GLOSA>Envio Procesado</GLOSA><ACEPTADOS>3</ACEPTADOS><RECHAZADOS>0</RECHAZADOS><REPAROS>0</REPAROS>"),
    )!;
    expect(e.estado).toBe("EPR");
    expect(e.aceptados).toBe(3);
    expect(envioAceptado(e)).toBe(true);
  });

  it("un envío procesado CON rechazados no cuenta como aceptado", () => {
    // Es la trampa: el SII procesó el envío (EPR) pero rechazó documentos adentro. Darlo por bueno
    // sería creer que están declarados.
    const e = extraerEstadoEnvio(
      respuesta("<ESTADO>EPR</ESTADO><ACEPTADOS>2</ACEPTADOS><RECHAZADOS>1</RECHAZADOS>"),
    )!;
    expect(envioAceptado(e)).toBe(false);
  });

  it("un envío sólo RECIBIDO todavía no está aceptado", () => {
    // El trackId acusa recepción, no aceptación. Son dos estados distintos.
    const e = extraerEstadoEnvio(respuesta("<ESTADO>SOK</ESTADO><GLOSA>Envio Recibido</GLOSA>"))!;
    expect(e.estado).toBe("SOK");
    expect(envioAceptado(e)).toBe(false);
  });

  it("un envío rechazado se lee con su glosa, que es lo que hay que mostrar", () => {
    const e = extraerEstadoEnvio(
      respuesta("<ESTADO>RCT</ESTADO><GLOSA>Error de Schema en el envio</GLOSA>"),
    )!;
    expect(envioAceptado(e)).toBe(false);
    expect(e.glosa).toBe("Error de Schema en el envio");
  });

  it("devuelve null en vez de inventar si la respuesta no trae estado", () => {
    expect(extraerEstadoEnvio("<html>502</html>")).toBeNull();
  });
});

describe("baseSii", () => {
  it("separa certificación de producción — el defecto que tiene el SDK", () => {
    expect(baseSii("certificacion")).toBe("https://maullin.sii.cl");
    expect(baseSii("produccion")).toBe("https://palena.sii.cl");
  });
});
