import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Sellado de secretos en reposo (la llave privada del certificado, el secreto de un webhook):
 * AES-256-GCM con una llave maestra que vive en el entorno, nunca en la base.
 *
 * Formato: `[versión 1B = 1][id de llave 1B][iv 12B][tag 16B][cifrado]`.
 *
 * - El **id de llave** permite rotar: se sella con la actual y se abre con la que diga el sello.
 * - El **AAD** ata el sello a su fila (p. ej. el id del contribuyente): copiar la llave sellada de un
 *   contribuyente a otro en la base produce un sello que no abre, en vez de firmar con la llave ajena.
 *
 * Dominio puro (sólo `node:crypto`).
 */

const VERSION = 1;

export interface Llavero {
  /** id → llave de 32 bytes. */
  llaves: ReadonlyMap<number, Buffer>;
  /** Con cuál se sella. */
  actual: number;
}

/**
 * `"2:BASE64,1:BASE64"` → llavero; la PRIMERA es la actual. Cada llave son 32 bytes en base64
 * (`openssl rand -base64 32`).
 */
export function leerLlavero(spec: string): Llavero {
  const llaves = new Map<number, Buffer>();
  let actual: number | null = null;
  for (const parte of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,3}):(.+)$/.exec(parte);
    if (!m) throw new Error("Cada llave del llavero va como <id>:<base64>.");
    const id = Number(m[1]);
    if (id < 1 || id > 255) throw new Error("El id de una llave va de 1 a 255.");
    const llave = Buffer.from(m[2]!, "base64");
    if (llave.length !== 32) throw new Error(`La llave ${id} no tiene 32 bytes (tiene ${llave.length}).`);
    if (llaves.has(id)) throw new Error(`La llave ${id} está repetida.`);
    llaves.set(id, llave);
    actual ??= id;
  }
  if (actual === null) throw new Error("El llavero está vacío.");
  return { llaves, actual };
}

export function sellar(plano: Buffer | string, aad: string, llavero: Llavero): Buffer {
  const llave = llavero.llaves.get(llavero.actual)!;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", llave, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const cifrado = Buffer.concat([c.update(typeof plano === "string" ? Buffer.from(plano, "utf8") : plano), c.final()]);
  return Buffer.concat([Buffer.from([VERSION, llavero.actual]), iv, c.getAuthTag(), cifrado]);
}

export function abrir(sellado: Buffer | Uint8Array, aad: string, llavero: Llavero): Buffer {
  const b = Buffer.from(sellado);
  if (b.length < 30 || b[0] !== VERSION) throw new Error("Sello con formato desconocido.");
  const llave = llavero.llaves.get(b[1]!);
  if (!llave) throw new Error(`El sello usa la llave ${b[1]}, que no está en el llavero.`);
  const d = createDecipheriv("aes-256-gcm", llave, b.subarray(2, 14));
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(b.subarray(14, 30));
  try {
    return Buffer.concat([d.update(b.subarray(30)), d.final()]);
  } catch {
    // Llave equivocada, AAD de otra fila o sello alterado: los tres son lo mismo para quien llama.
    throw new Error("El sello no abre: llave equivocada, fila equivocada o dato alterado.");
  }
}

/** ¿Hay que re-sellar con la llave actual? (rotación) */
export function selladoConOtraLlave(sellado: Buffer | Uint8Array, llavero: Llavero): boolean {
  return Buffer.from(sellado)[1] !== llavero.actual;
}
