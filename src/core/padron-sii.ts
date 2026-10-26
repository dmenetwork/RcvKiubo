/**
 * Lectura del padrón público de contribuyentes autorizados a facturar electrónicamente.
 *
 * ── QUÉ ES ESTO Y POR QUÉ ES LEGÍTIMO ──────────────────────────────────────────────────────────
 *
 * El SII **no publica** un servicio REST de situación tributaria. Lo verificamos: el catálogo de
 * `DTEWS` (QueryEstDte, QueryEstUp, QueryEstDteAv, wsRPETCConsulta, wsDTECorreo…) pregunta por
 * DOCUMENTOS ya emitidos —tipo, folio, fecha y monto—, no por un RUT a secas; y la descarga masiva
 * del padrón exige una sesión con certificado digital.
 *
 * Lo que sí hay, público y sin credenciales, es la consulta uno-a-uno que el propio SII designa como
 * el lugar de esta pregunta. Res. Ex. SII N°45/2003, resolutivo **Séptimo**: *"En el sitio Web del
 * SII, se podrá consultar sobre los contribuyentes autorizados, primer período de vigencia y
 * documentos que cada contribuyente está autorizado a emitir en forma electrónica."*
 *
 * ── EL PUENTE NORMATIVO, QUE ES LO QUE HACE ÚTIL LA RESPUESTA ──────────────────────────────────
 *
 * La pregunta que un ERP necesita responder no es "¿es emisor?" sino "¿cómo le entrego el
 * documento?". La misma resolución la contesta:
 *
 *  · Resolutivo **Quinto n°1**: *"Todo emisor electrónico será obligatoriamente un receptor
 *    electrónico"*. Estar en el padrón como emisor ⇒ es receptor electrónico.
 *  · Definición **letra c)**: *"Receptor No Electrónico: Todo receptor de un documento tributario
 *    electrónico que no es emisor electrónico; también se denomina «receptor manual»."*
 *  · Resolutivo **Cuarto n°5**: *"Si el receptor es no electrónico, el emisor deberá entregarle una
 *    representación impresa del documento electrónico… Si el receptor es electrónico, el emisor
 *    deberá entregarle por medios electrónicos un ejemplar del documento electrónico"*.
 *
 * Por eso el resultado útil es `comoEntregar`, no un booleano suelto: **no estar en el padrón NUNCA
 * es motivo para no facturar.** Es la instrucción de cómo entregar el documento — papel en vez de
 * XML. Quien use este dato como compuerta para negar una venta lo está usando mal, y el nombre del
 * campo existe para que eso sea evidente.
 *
 * ── FALLA CERRADO ──────────────────────────────────────────────────────────────────────────────
 *
 * Es HTML de un tercero que puede cambiar sin aviso. Cuando la página no coincide con ninguna de las
 * tres formas conocidas, el resultado es `ilegible` — nunca "no autorizado". Un `false` inventado
 * porque el SII cambió una plantilla haría que un ERP le entregara papel a quien espera XML, y peor:
 * quedaría cacheado 24 horas.
 *
 * ── EN KIUBO ───────────────────────────────────────────────────────────────────────────────────
 *
 * Alimenta `emisores.tipos_autorizados` (R13 de `docs/PLAN-MIGRACION-CHONCHI.md`): la lista de
 * `documentos` vigentes (sin `desautorizadoDesde`) es lo que el emisor puede emitir, y emitir un
 * tipo fuera de ella quema el folio para que el SII lo rechace después. Port casi literal de
 * `api-facturacion/api/core/padron-sii.ts`; desde R14 este archivo es el ORIGEN y aquel copia.
 *
 * Módulo PURO: no hace red. Recibe el HTML ya descargado.
 */

/** Un tipo de documento que el contribuyente puede (o pudo) emitir. */
export interface DocumentoAutorizado {
  codigo: number;
  descripcion: string;
  /** `DD-MM-AAAA` tal como lo publica el SII. */
  autorizadoDesde: string | null;
  /** Presente si el SII lo desautorizó. */
  desautorizadoDesde: string | null;
}

export interface DatosContribuyente {
  rut: string;
  razonSocial: string;
  numeroResolucion: string | null;
  fechaResolucion: string | null;
  direccionRegional: string | null;
}

export type ResultadoPadron =
  /** Emisor electrónico: puede emitir los tipos que lista, y por lo tanto ES receptor electrónico. */
  | ({ clase: "emisor"; documentos: DocumentoAutorizado[] } & DatosContribuyente)
  /** Autorizado SOLO como receptor: recibe DTE por medios electrónicos, no los emite. */
  | ({ clase: "solo_receptor"; documentos: [] } & DatosContribuyente)
  /** No figura en el padrón. Es un receptor NO electrónico: se le entrega representación impresa. */
  | { clase: "ausente" }
  /** El SII respondió algo que no reconocemos. NO es "no autorizado". */
  | { clase: "ilegible"; motivo: string };

const ENTIDADES: Record<string, string> = {
  "&aacute;": "á", "&eacute;": "é", "&iacute;": "í", "&oacute;": "ó", "&uacute;": "ú",
  "&ntilde;": "ñ", "&Aacute;": "Á", "&Eacute;": "É", "&Iacute;": "Í", "&Oacute;": "Ó",
  "&Uacute;": "Ú", "&Ntilde;": "Ñ", "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&#176;": "°",
};

/** Texto plano de un fragmento de HTML, con las entidades del SII resueltas. */
function texto(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-zA-Z]+;|&#\d+;/g, (e) => ENTIDADES[e] ?? " ")
    // El SII sirve la página en ISO-8859-1; el `°` de "N° Resolución" llega como 0xB0. Si alguien
    // decodificó mal, aparece como U+FFFD y no debe romper el reconocimiento del rótulo.
    .replace(/�/g, "°")
    .replace(/\s+/g, " ")
    .trim();
}

/** Las celdas de una tabla, en orden. */
function celdas(html: string): string[] {
  return [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => texto(m[1]!));
}

/**
 * Interpreta la respuesta del padrón.
 *
 * Las tres formas están tomadas de respuestas REALES de producción, guardadas como fixtures en
 * `core/__fixtures__/recepcion/padron/`. Si el SII cambia la plantilla, el test que las lee sigue
 * verde (son archivos): lo que lo detecta es una consulta en vivo (en api-facturacion,
 * `scripts/smoke-padron.ts`). Esa división es a propósito: la suite no puede depender de que el SII
 * esté arriba.
 */
export function interpretarPadron(html: string): ResultadoPadron {
  const plano = texto(html);

  // Forma 3, la más barata de reconocer: el rut no está en el padrón.
  if (/no corresponde a una empresa autorizada/i.test(plano)) {
    return { clase: "ausente" };
  }

  // Las otras dos empiezan igual: la tabla de antecedentes.
  if (!/Los antecedentes de la empresa son/i.test(plano)) {
    return {
      clase: "ilegible",
      motivo:
        "la respuesta del SII no tiene ninguna de las tres formas conocidas " +
        "(antecedentes, solo receptor, o no autorizado)",
    };
  }

  const tablas = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]!);
  const datos: Record<string, string> = {};
  for (const tabla of tablas) {
    const c = celdas(tabla);
    for (let i = 0; i + 1 < c.length; i += 2) {
      const rotulo = c[i]!.toLowerCase();
      const valor = c[i + 1]!;
      if (rotulo.startsWith("rut")) datos["rut"] = valor;
      else if (rotulo.includes("social")) datos["razonSocial"] = valor;
      else if (rotulo.includes("resoluci") && rotulo.includes("n°")) datos["numeroResolucion"] = valor;
      else if (rotulo.includes("fecha")) datos["fechaResolucion"] = valor;
      else if (rotulo.includes("regional")) datos["direccionRegional"] = valor;
    }
  }

  if (!datos["rut"] || !datos["razonSocial"]) {
    return {
      clase: "ilegible",
      motivo: "el SII devolvió la página de antecedentes pero sin el RUT o la razón social",
    };
  }

  const base: DatosContribuyente = {
    rut: datos["rut"],
    razonSocial: datos["razonSocial"],
    numeroResolucion: datos["numeroResolucion"] ?? null,
    fechaResolucion: datos["fechaResolucion"] ?? null,
    direccionRegional: datos["direccionRegional"] ?? null,
  };

  if (/s[oó]lo est[aá] autorizado como receptor/i.test(plano)) {
    return { clase: "solo_receptor", documentos: [], ...base };
  }

  if (!/tiene autorizada la emisi[oó]n/i.test(plano)) {
    return {
      clase: "ilegible",
      motivo:
        "hay antecedentes de la empresa pero el SII no dice ni que emite ni que solo recibe: " +
        "la plantilla cambió",
    };
  }

  // La tabla de documentos: 4 columnas (código, descripción, autorizado, desautorizado). La fila de
  // encabezado se descarta por no tener un código numérico.
  const documentos: DocumentoAutorizado[] = [];
  for (const tabla of tablas) {
    for (const fila of tabla.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      const c = celdas(fila[0]!);
      if (c.length < 3) continue;
      const codigo = Number(c[0]);
      if (!Number.isInteger(codigo) || codigo <= 0) continue;
      documentos.push({
        codigo,
        descripcion: c[1] ?? "",
        autorizadoDesde: c[2] || null,
        desautorizadoDesde: c[3] || null,
      });
    }
  }

  if (documentos.length === 0) {
    return {
      clase: "ilegible",
      motivo: "el SII dice que el contribuyente emite documentos pero no se pudo leer cuáles",
    };
  }

  return { clase: "emisor", documentos, ...base };
}

/** Cómo hay que entregarle el documento a este receptor. Es la salida ACCIONABLE. */
export type FormaDeEntrega = "electronica" | "impresa" | "desconocida";

/**
 * Traduce el resultado del padrón a lo único que el ERP tiene que decidir.
 *
 * `impresa` NO significa "no le factures": significa que hay que darle la representación impresa,
 * como manda el resolutivo Cuarto n°5 de la Res. Ex. 45/2003.
 */
export function formaDeEntrega(r: ResultadoPadron): FormaDeEntrega {
  switch (r.clase) {
    case "emisor":
    case "solo_receptor":
      return "electronica";
    case "ausente":
      return "impresa";
    default:
      return "desconocida";
  }
}
