/**
 * Material criptográfico de prueba para los tests de recepción: un certificado X.509 REAL (con
 * openssl, como los de `workers/dte-boleta.integration.test.ts`), una llave que hace de "SII" para
 * firmar la FRMA de los CAF, y un armador de `<DTE>` firmado y timbrado con el código de Kiubo.
 *
 * El "SII" es una llave nuestra: la llave pública verdadera del SII no está en el repo (ver
 * `LLAVES_PUBLICAS_SII` en `core/dte-verificacion.ts`), así que estos tests prueban el ALGORITMO de
 * verificación de la FRMA, no la llave.
 */

import { execFileSync } from "node:child_process";
import { createPublicKey, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firmarDocumento, firmarTed, type CertificadoFirmante } from "../dte-firma";

const b64 = (urlsafe: string) => Buffer.from(urlsafe, "base64url").toString("base64");

/** Certificado autofirmado de verdad (X.509 legible), con su llave y su RSAKeyValue. */
export function certificadoDePrueba(): CertificadoFirmante {
  const dir = mkdtempSync(join(tmpdir(), "kiubo-recep-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      "-days", "30", "-nodes", "-subj", "/C=CL/CN=FIRMANTE PRUEBA/serialNumber=11598736-4",
    ], { stdio: "ignore" });
    const llavePrivadaPem = readFileSync(join(dir, "k.pem"), "utf8");
    const pem = readFileSync(join(dir, "c.pem"), "utf8");
    const jwk = createPublicKey(llavePrivadaPem).export({ format: "jwk" }) as { n: string; e: string };
    return {
      llavePrivadaPem,
      modulus: b64(jwk.n),
      exponent: b64(jwk.e),
      x509: pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Par de llaves que hace de "SII": firma la FRMA del CAF. */
export function llaveSiiDePrueba(): { privada: string; publica: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  return {
    privada: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
    publica: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

/** FRMA como la calcula el SII: SHA1withRSA sobre el `<DA>` aplanado, en Latin-1. */
export function firmarDa(da: string, llaveSiiPrivada: string): string {
  const f = createSign("RSA-SHA1");
  f.update(Buffer.from(da.replace(/>\s+</g, "><"), "latin1"));
  return f.sign(llaveSiiPrivada).toString("base64");
}

export interface CafDePrueba {
  /** El `<CAF>…</CAF>` aplanado, listo para ir dentro del `<DD>`. */
  bloque: string;
  /** Llave privada del timbraje (RSASK), para firmar el FRMT. */
  llavePrivada: string;
  /** El `<DA>` con saltos de línea, como viene en el archivo que entrega el SII. */
  daConSaltos: string;
  frma: string;
}

export function cafDePrueba(opts: {
  rutEmisor: string;
  tipoDte: number;
  desde?: number;
  hasta?: number;
  idk?: string;
  llaveSii: string;
}): CafDePrueba {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 512 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const daConSaltos =
    `<DA>\n<RE>${opts.rutEmisor}</RE>\n<RS>COMERCIAL ÑANDÚ LTDA</RS>\n<TD>${opts.tipoDte}</TD>\n` +
    `<RNG><D>${opts.desde ?? 1}</D><H>${opts.hasta ?? 100}</H></RNG>\n<FA>2026-09-01</FA>\n` +
    `<RSAPK><M>${b64(jwk.n)}</M><E>${b64(jwk.e)}</E></RSAPK>\n<IDK>${opts.idk ?? "100"}</IDK>\n</DA>`;
  const frma = firmarDa(daConSaltos, opts.llaveSii);
  return {
    bloque: `<CAF version="1.0">${daConSaltos.replace(/>\s+</g, "><")}<FRMA algoritmo="SHA1withRSA">${frma}</FRMA></CAF>`,
    llavePrivada: privateKey.export({ type: "pkcs1", format: "pem" }) as string,
    daConSaltos,
    frma,
  };
}

export const RUT_PROVEEDOR = "76086428-5";
export const RUT_KIUBO = "77840802-3";

export interface OpcionesDte {
  tipoDte?: number;
  folio: number;
  /** Texto YA escapado como lo escribiría el emisor (puede traer `&quot;`). */
  rznSoc?: string;
  nmbItem?: string;
  neto?: number;
  exento?: number;
  iva?: number;
  /** `<ImptoReten>` de los totales. */
  impuestos?: Array<{ codigo: number; tasa: number; monto: number }>;
  /** Fuerza un MntTotal (por defecto, la suma correcta con los adicionales). */
  total?: number;
  referenciasXml?: string;
}

/**
 * Un `<DTE>` de proveedor firmado con `firmarDocumento` y timbrado con `firmarTed` de Kiubo, en la
 * forma que lo arma el motor (documento suelto, sin xmlns, firma después del `</Documento>`).
 */
export function dteDePrueba(o: OpcionesDte, caf: CafDePrueba, cert: CertificadoFirmante): string {
  const tipo = o.tipoDte ?? 33;
  const neto = o.neto ?? 10_000;
  const iva = o.iva ?? Math.round(neto * 0.19);
  const exento = o.exento ?? 0;
  const impuestos = o.impuestos ?? [];
  const total = o.total ?? neto + iva + exento + impuestos.reduce((s, i) => s + i.monto, 0);
  const id = `F${o.folio}T${tipo}`;
  const rznSoc = o.rznSoc ?? "COMERCIAL ÑANDÚ &quot;LA ESTRELLA&quot; LTDA";
  const item = o.nmbItem ?? "AZÚCAR GRANULADA 1KG";

  const dd =
    `<DD><RE>${RUT_PROVEEDOR}</RE><TD>${tipo}</TD><F>${o.folio}</F><FE>2026-10-01</FE>` +
    `<RR>${RUT_KIUBO}</RR><RSR>SOCIEDAD G Y A</RSR><MNT>${total}</MNT><IT1>${item}</IT1>` +
    `${caf.bloque}<TSTED>2026-10-01T10:00:00</TSTED></DD>`;
  const documento =
    `<Documento ID="${id}">\n<Encabezado>\n` +
    `<IdDoc><TipoDTE>${tipo}</TipoDTE><Folio>${o.folio}</Folio><FchEmis>2026-10-01</FchEmis></IdDoc>\n` +
    `<Emisor><RUTEmisor>${RUT_PROVEEDOR}</RUTEmisor><RznSoc>${rznSoc}</RznSoc>` +
    `<GiroEmis>DISTRIBUCIÓN DE ABARROTES</GiroEmis><Acteco>463000</Acteco>` +
    `<DirOrigen>PEDRO MONTT 120</DirOrigen><CmnaOrigen>CASTRO</CmnaOrigen></Emisor>\n` +
    `<Receptor><RUTRecep>${RUT_KIUBO}</RUTRecep><RznSocRecep>SOCIEDAD G Y A</RznSocRecep></Receptor>\n` +
    `<Totales>` +
    (neto ? `<MntNeto>${neto}</MntNeto>` : "") +
    (exento ? `<MntExe>${exento}</MntExe>` : "") +
    (iva ? `<TasaIVA>19</TasaIVA><IVA>${iva}</IVA>` : "") +
    impuestos
      .map((i) => `<ImptoReten><TipoImp>${i.codigo}</TipoImp><TasaImp>${i.tasa}</TasaImp><MontoImp>${i.monto}</MontoImp></ImptoReten>`)
      .join("") +
    `<MntTotal>${total}</MntTotal></Totales>\n</Encabezado>\n` +
    `<Detalle><NroLinDet>1</NroLinDet><NmbItem>${item}</NmbItem><QtyItem>1</QtyItem>` +
    `<PrcItem>${neto + exento}</PrcItem><MontoItem>${neto + exento}</MontoItem></Detalle>\n` +
    (o.referenciasXml ?? "") +
    `<TED version="1.0">${dd}<FRMT algoritmo="SHA1withRSA">${firmarTed(dd, caf.llavePrivada)}</FRMT></TED>\n` +
    `<TmstFirma>2026-10-01T10:00:00</TmstFirma>\n</Documento>`;
  return `<DTE version="1.0">\n${documento}\n${firmarDocumento(documento, id, cert)}\n</DTE>`;
}
