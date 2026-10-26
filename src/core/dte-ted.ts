import { createPublicKey, createVerify } from "node:crypto";
import { clasificarImpuestos } from "./dte-impuestos";
import { bloqueDe, contenidoDe, elementos } from "./xml-lineal";

/**
 * Verificación LOCAL del timbre electrónico (TED) de un DTE ya emitido.
 *
 * ## Por qué existe
 *
 * El envío al SII está bloqueado (el SDK sube siempre a palena), así que no hay forma de preguntarle
 * a ellos si el documento está bien. Esta es la verificación más cercana que se puede hacer sin
 * salir de casa: el TED lleva **la llave pública dentro** —el bloque `<CAF>` viaja embebido en el
 * `<DD>`, con su `<RSAPK>`— así que se puede comprobar que la firma `<FRMT>` corresponde a ese
 * `<DD>` y a esa llave.
 *
 * Atrapa toda una clase de defectos sin depender de nadie: un `<DD>` mal formado, un escapado que
 * corrompe el bloque, una llave que no corresponde, un truncado que parte una entidad.
 *
 * ## Lo que NO prueba
 *
 * Que el SII lo acepte. Son cosas distintas y conviene no confundirlas:
 *
 * - `<FRMT>` (lo que se verifica acá) es **nuestra** firma del timbre. Que valide significa que el
 *   timbrado funcionó.
 * - `<FRMA>` es la firma **del SII** sobre el CAF, y prueba que ellos autorizaron ese rango. Con un
 *   CAF sintético esa firma no es auténtica y el SII lo rechaza, por mucho que el `<FRMT>` valide.
 *
 * O sea: esto responde "¿timbramos bien?", no "¿nos van a aceptar?".
 *
 * Dominio puro: no toca red, disco ni base de datos.
 */

export type ResultadoTed =
  | { valido: true }
  | { valido: false; motivo: string };

// Lineales (`core/xml-lineal`), mismo resultado que `<tag\b[^>]*>[\s\S]*?</tag>`: este archivo también
// verifica DTE RECIBIDOS (vía dte-verificacion), y ahí el regex perezoso era cuadrático.
/** Saca un bloque completo con sus etiquetas, tal cual está en el texto. */
const bloque = (xml: string, tag: string): string | null => bloqueDe(xml, tag);

const contenido = (xml: string, tag: string): string | null => contenidoDe(xml, tag);

/**
 * Arma una llave pública RSA a partir del módulo y exponente en base64 del CAF.
 *
 * El SII los entrega en base64 crudo (no PEM, no JWK), así que hay que reconstruir la llave. Se pasa
 * por JWK, que acepta base64url — de ahí la conversión de alfabeto.
 */
function llavePublicaDesdeCaf(modulusB64: string, exponentB64: string) {
  const aBase64Url = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return createPublicKey({
    key: {
      kty: "RSA",
      n: aBase64Url(modulusB64.trim()),
      e: aBase64Url(exponentB64.trim()),
    },
    format: "jwk",
  });
}

/**
 * El bloque `<TED>...</TED>` del DTE, VERBATIM: tal cual está en el texto, byte a byte, con sus
 * espacios y saltos intactos. NUNCA re-serializar ni "limpiar" lo que devuelve: la firma `<FRMT>`
 * se calculó sobre esos bytes exactos, y el PDF417 de la representación impresa debe llevar lo
 * mismo que el documento — un espacio movido y el timbre que se escanea ya no valida contra lo
 * que se emitió.
 *
 * Recibe el XML del DTE firmado ya DECODIFICADO como texto (el archivo es ISO-8859-1: decodificar
 * el buffer con "latin1"). Un documento sin `<TED>` corta con error explícito: es un documento sin
 * timbrar y el llamador decide si degrada o reporta.
 */
export function extraerTed(xmlDte: string): string {
  const ted = bloque(xmlDte, "TED");
  if (!ted) {
    throw new Error("el documento no tiene bloque <TED> (no está timbrado)");
  }
  return ted;
}

/**
 * ¿La firma del timbre corresponde al documento y a la llave que el propio documento publica?
 *
 * Recibe el XML del DTE **firmado**, tal como lo devuelve el motor.
 */
export function verificarFirmaTed(xmlDte: string): ResultadoTed {
  // La firma, el <DD> y la llave tienen que ser del MISMO timbre: con "el primero que aparezca", un
  // falsificador pone su propia llave antes del CAF real (que cualquier factura de un proveedor trae)
  // y timbra con ella. Por eso: un solo <TED>, un solo <DD> y un solo <CAF> adentro, y la llave sale
  // de <DD><CAF>…<RSAPK>, no de cualquier <M>/<E>.
  const teds = elementos(xmlDte, "TED", "palabra", 2);
  if (teds.length > 1) return { valido: false, motivo: "el documento trae más de un <TED>" };
  const ted = teds[0] ? xmlDte.slice(teds[0].inicio, teds[0].fin) : "";
  const dds = elementos(ted, "DD", "exacta", 2);
  if (dds.length === 0) return { valido: false, motivo: "el documento no tiene bloque <DD> (no está timbrado)" };
  if (dds.length > 1) return { valido: false, motivo: "el timbre trae más de un <DD>" };
  const dd = ted.slice(dds[0].inicio, dds[0].fin);

  const frmt = contenido(ted, "FRMT");
  if (!frmt) return { valido: false, motivo: "el documento no tiene <FRMT> (falta la firma del timbre)" };

  const cafs = elementos(dd, "CAF", "palabra", 2);
  if (cafs.length !== 1) return { valido: false, motivo: "el <DD> debe traer exactamente un <CAF>" };
  // La llave es la del <DA>: lo único que firma la FRMA del SII. Un <RSAPK> de adorno en otra parte del
  // CAF (antes del <DA> real copiado de otra factura) no cuenta.
  const caf = dd.slice(cafs[0].inicio, cafs[0].fin);
  const das = elementos(caf, "DA", "exacta", 2);
  if (das.length !== 1) return { valido: false, motivo: "el <CAF> debe traer exactamente un <DA>" };
  const da = caf.slice(das[0].contenidoInicio, das[0].contenidoFin);
  const rsapks = elementos(da, "RSAPK", "exacta", 2);
  if (rsapks.length !== 1) return { valido: false, motivo: "el <DA> debe traer exactamente un <RSAPK>" };
  const rsapk = da.slice(rsapks[0].contenidoInicio, rsapks[0].contenidoFin);
  const modulus = contenido(rsapk, "M");
  const exponent = contenido(rsapk, "E");
  if (!modulus || !exponent) {
    return { valido: false, motivo: "el CAF embebido no publica <RSAPK> (módulo y exponente)" };
  }
  // Las llaves de CAF del SII son de 512 bits. Una de 16.384 bits con exponente enorme no es un CAF:
  // es CPU que un desconocido le hace gastar al proceso del POS (~1,7 ms por verificación, ×500 DTE).
  if (Buffer.from(modulus.trim(), "base64").length > 256 || Buffer.from(exponent.trim(), "base64").length > 4) {
    return { valido: false, motivo: "la llave del CAF tiene un tamaño que no corresponde a un CAF del SII" };
  }

  let llave;
  try {
    llave = llavePublicaDesdeCaf(modulus, exponent);
  } catch (e) {
    // Pasa con un CAF de juguete cuyo módulo no es un entero RSA válido.
    return {
      valido: false,
      motivo: `el <RSAPK> del CAF no es una llave RSA válida: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // El SII firma el <DD> COMPLETO, con sus etiquetas, byte a byte y sin reformatear: el documento va
  // en ISO-8859-1, así que se verifica sobre esos bytes y no sobre UTF-8.
  const verificador = createVerify("RSA-SHA1");
  verificador.update(Buffer.from(dd, "latin1"));
  const ok = verificador.verify(llave, Buffer.from(frmt.trim(), "base64"));

  return ok
    ? { valido: true }
    : { valido: false, motivo: "la firma <FRMT> no corresponde al <DD> y la llave publicada" };
}

/**
 * Chequeos aritméticos del documento contra sí mismo.
 *
 * El manual del SII define `MntTotal = MntNeto + MntExe + IVA + adicionales − retenciones`
 * (`formato_dte_pdf.md:513`). Un documento que no cumple eso está mal aunque el SII no lo rechace —
 * el manual dice explícitamente que ellos no validan contenido, así que esta es nuestra red. Cada
 * `<ImptoReten>` entra según su `<TipoImp>` (`core/dte-impuestos.ts`): el ILA suma, la retención de una
 * factura de compra resta, y un código fuera de la tabla no se puede cuadrar.
 */
export function verificarTotales(xmlDte: string): ResultadoTed {
  const num = (tag: string): number => {
    const v = contenido(xmlDte, tag);
    return v ? Number(v.trim()) : 0;
  };
  const neto = num("MntNeto");
  const exento = num("MntExe");
  const iva = num("IVA");
  const total = num("MntTotal");

  const { adicionales, retenciones, desconocidos } = clasificarImpuestos(
    elementos(xmlDte, "ImptoReten", "exacta").map((e) => {
      const imp = xmlDte.slice(e.contenidoInicio, e.contenidoFin);
      return {
        codigo: Number(contenido(imp, "TipoImp")?.trim()),
        monto: Number(contenido(imp, "MontoImp")?.trim() ?? 0),
      };
    }),
  );
  if (desconocidos.length > 0) {
    return {
      valido: false,
      motivo: `impuesto con código fuera de la tabla del SII (${desconocidos.join(", ")}): no se puede cuadrar el total`,
    };
  }

  const suma = neto + exento + iva + adicionales - retenciones;
  if (suma !== total) {
    return {
      valido: false,
      motivo:
        `MntTotal ${total} no es la suma de sus partes ` +
        `(neto ${neto} + exento ${exento} + IVA ${iva} + adicionales ${adicionales} − retenciones ${retenciones} = ${suma})`,
    };
  }
  return { valido: true };
}

/** Ningún carácter de control: el XML 1.0 los prohíbe y el documento se firma igual. */
export function verificarSinCaracteresDeControl(bytes: Buffer): ResultadoTed {
  const malos = [...bytes].filter((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d);
  return malos.length === 0
    ? { valido: true }
    : {
        valido: false,
        motivo: `el documento tiene ${malos.length} carácter(es) de control: ${[
          ...new Set(malos),
        ]
          .map((b) => "0x" + b.toString(16))
          .join(", ")}`,
      };
}
