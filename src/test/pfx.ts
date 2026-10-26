import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";

/** Un .pfx de prueba (RSA 2048) con el RUT donde lo ponen los certificados chilenos. */
export function pfxDePrueba(opts: {
  clave: string;
  rutEn?: "subject" | "san" | "ninguno";
  algoritmo?: "3des" | "aes256";
  rut?: string;
  validoHasta?: Date;
}): Buffer {
  const rutEn = opts.rutEn ?? "subject";
  const rut = opts.rut ?? "11598736-4";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const llave = forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" }) as string) as forge.pki.rsa.PrivateKey;
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(llave.n, llave.e);
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = opts.validoHasta ?? new Date("2028-01-01T00:00:00Z");
  const subject: forge.pki.CertificateField[] = [{ shortName: "CN", value: "JUAN PEREZ SOTO" }];
  if (rutEn === "subject") subject.push({ name: "serialNumber", value: rut });
  cert.setSubject(subject);
  // La CA también trae un RUT: NO debe confundirse con el del titular.
  cert.setIssuer([{ shortName: "CN", value: "E-CERTCHILE CA FIRMA ELECTRONICA" }, { name: "serialNumber", value: "96928180-5" }]);
  if (rutEn === "san") {
    const a = forge.asn1;
    const otherName = a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
      a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer("1.3.6.1.4.1.8321.1").getBytes()),
      a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [a.create(a.Class.UNIVERSAL, a.Type.IA5STRING, false, rut)]),
    ]);
    cert.setExtensions([{ name: "subjectAltName", value: a.toDer(a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [otherName])).getBytes() }]);
  }
  cert.sign(llave, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(llave, [cert], opts.clave, { algorithm: opts.algoritmo ?? "3des" });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}
