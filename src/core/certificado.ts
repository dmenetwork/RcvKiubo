import { X509Certificate, createHash, createPublicKey, createSign, createVerify } from "node:crypto";
import forge from "node-forge";
import type { CertificadoFirmante } from "./dte-firma";
import { rutSii } from "./rut";

/**
 * Lectura del certificado digital (`.pfx`/`.p12`) del titular que firma ante el SII.
 *
 * Node no lee PKCS#12 (`createPrivateKey` rechaza `pkcs12`). Kiubo resuelve con el binario
 * `openssl`; acá se usa `node-forge` para no depender de un ejecutable del sistema, y además lee sin
 * ayuda los `.pfx` viejos cifrados con RC2-40/3DES (los que entregan E-Cert/Acepta), que OpenSSL 3
 * sólo abre con `-legacy`.
 *
 * El aviso de `npm audit` sobre node-forge (GHSA-86w9-cpqp-85rv) es de su VERIFICACIÓN de firmas
 * RSA. Acá forge sólo desarma el PKCS#12: toda firma y verificación la hace `node:crypto`.
 *
 * Dominio puro: no toca red, disco ni base. La llave privada vive en memoria lo que dura la llamada.
 */

export interface CertificadoLeido {
  firmante: CertificadoFirmante;
  /** RUT del titular, del propio certificado. `null` si no lo trae (se pide al cargarlo). */
  rutTitular: string | null;
  nombreTitular: string;
  emisor: string;
  validoDesde: Date;
  validoHasta: Date;
  /** sha256 del DER, en hex: identifica el certificado sin exponer nada. */
  huella: string;
}

export class CertificadoInvalidoError extends Error {
  constructor(
    readonly codigo: "PFX_ILEGIBLE" | "PFX_SIN_LLAVE" | "PFX_LLAVE_NO_CORRESPONDE",
    mensaje: string,
  ) {
    super(mensaje);
    this.name = "CertificadoInvalidoError";
  }
}

const RUT = /\b(\d{7,8}-[\dkK])\b/;

/** Todos los textos dentro de un valor ASN.1 de forge (para el `otherName` del SAN). */
function textosAsn1(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => textosAsn1(x, out));
  else if (v && typeof v === "object" && "value" in v) textosAsn1((v as { value: unknown }).value, out);
  return out;
}

/**
 * El RUT del titular: el `serialNumber` del subject o el `otherName` del SAN (OID de e-CertChile
 * 1.3.6.1.4.1.8321.1). NUNCA se busca en todo el certificado: el del EMISOR (la CA) también trae un
 * RUT y no es el del titular.
 */
function rutDelCertificado(cert: forge.pki.Certificate): string | null {
  for (const attr of cert.subject.attributes) {
    const m = RUT.exec(String(attr.value ?? ""));
    if (m) return rutSii(m[1]!) || null;
  }
  const san = cert.getExtension("subjectAltName") as { altNames?: Array<{ type: number; value: unknown }> } | null;
  for (const alt of san?.altNames ?? []) {
    for (const t of textosAsn1(alt.value)) {
      const m = RUT.exec(t);
      if (m) return rutSii(m[1]!) || null;
    }
  }
  return null;
}

const b64url = (s: string) => Buffer.from(s, "base64url").toString("base64");

export function leerPfx(pfx: Buffer, clave: string): CertificadoLeido {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString("binary")));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, clave);
  } catch (e) {
    throw new CertificadoInvalidoError(
      "PFX_ILEGIBLE",
      `No se pudo abrir el certificado: revisa que sea un .pfx/.p12 y que la clave sea correcta ` +
        `(${e instanceof Error ? e.message : String(e)}).`,
    );
  }

  const bolsasLlave = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const llave = bolsasLlave.map((b) => b.key).find(Boolean) as forge.pki.rsa.PrivateKey | undefined;
  if (!llave) throw new CertificadoInvalidoError("PFX_SIN_LLAVE", "El .pfx no contiene una llave privada.");

  // Un .pfx puede traer la cadena completa: el del titular es el que corresponde a la llave.
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => !!c);
  const cert = certs.find((c) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey;
    return pub.n?.equals(llave.n) && pub.e?.equals(llave.e);
  });
  if (!cert) {
    throw new CertificadoInvalidoError(
      "PFX_LLAVE_NO_CORRESPONDE",
      "El .pfx trae una llave privada pero ningún certificado que le corresponda.",
    );
  }

  const llavePrivadaPem = forge.pki.privateKeyToPem(llave);
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), "binary");
  const x509 = new X509Certificate(der);

  // Prueba de fuego: la llave firma y el certificado verifica esa firma. Un certificado que no sirve,
  // descubierto al pedir el token, es un SII que rechaza sin decir por qué.
  const prueba = Buffer.from("rcv-kiubo");
  const firma = createSign("RSA-SHA256").update(prueba).sign(llavePrivadaPem);
  if (!createVerify("RSA-SHA256").update(prueba).verify(x509.publicKey, firma)) {
    throw new CertificadoInvalidoError("PFX_LLAVE_NO_CORRESPONDE", "La llave privada no corresponde al certificado.");
  }

  const jwk = createPublicKey(llavePrivadaPem).export({ format: "jwk" }) as { n: string; e: string };
  const cn = (dn: forge.pki.Certificate["subject"]) =>
    String(dn.getField("CN")?.value ?? dn.attributes.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(", "));

  return {
    firmante: {
      llavePrivadaPem,
      modulus: b64url(jwk.n),
      exponent: b64url(jwk.e),
      x509: der.toString("base64"),
    },
    rutTitular: rutDelCertificado(cert),
    nombreTitular: cn(cert.subject),
    emisor: cn(cert.issuer),
    validoDesde: new Date(x509.validFrom),
    validoHasta: new Date(x509.validTo),
    huella: createHash("sha256").update(der).digest("hex"),
  };
}

/** Reconstruye el firmante desde lo guardado: la llave (des-sellada) y el X.509 en base64. */
export function firmanteDesde(llavePrivadaPem: string, x509Base64: string): CertificadoFirmante {
  const jwk = createPublicKey(llavePrivadaPem).export({ format: "jwk" }) as { n: string; e: string };
  return { llavePrivadaPem, modulus: b64url(jwk.n), exponent: b64url(jwk.e), x509: x509Base64 };
}
