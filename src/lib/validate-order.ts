/**
 * Validacion estricta del request de `POST /v1/ordenes` (B4; RFC rev. 4
 * 3.2, 3.2.1 y 6.2; AC-9, AC-17, AC-19; ADR-0016 y ADR-0020).
 *
 * Funcion pura, sin I/O. Reglas de privacidad (ADR-0020): los errores llevan
 * solo `campo` y `codigo`, JAMAS el valor recibido; el resultado `ok` es el
 * unico lugar donde viaja el contacto (nombre ya normalizado) y es para el
 * render y el HMAC, nunca para logs ni persistencia.
 *
 * No verifica la firma del `form_token` (B7), ni precios contra el catalogo
 * ni `total_visto === suma` (B6): solo la forma.
 */
import type { CampoOrden, CodigoError, CrearOrdenRequest } from "../wire.js";

/** Tope del body (RFC 3.2): 16 KB. */
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_LINEAS = 100;
export const NOMBRE_MIN = 2;
export const NOMBRE_MAX = 80;
export const TELEFONO_DIGITOS_MIN = 8;
export const TELEFONO_DIGITOS_MAX = 15;
export const CANTIDAD_MIN = 1;
export const CANTIDAD_MAX = 20;

export type ErrorOrden = { campo: CampoOrden | null; codigo: CodigoError };

/** Orden validada; `contacto.nombre` es el valor normalizado (3.2.1). */
export type OrdenValida = Omit<CrearOrdenRequest, "sitio_web">;

export type ResultadoValidacion =
  | { ok: true; orden: OrdenValida }
  // 422 `invalida`. Honeypot: `errores: []`, sin pista del motivo (6.2).
  | { ok: false; motivo: "invalida"; errores: ErrorOrden[] }
  // Body > 16 KB o JSON que no parsea: el handler decide el status.
  | { ok: false; motivo: "demasiado_grande" | "json_invalido" };

// --- Texto ------------------------------------------------------------------

// Cc (incluye CR, LF, tab), separadores de linea/parrafo U+2028/9, controles
// bidi U+202A-202E y U+2066-2069, y sustitutos sueltos (en modo `u`, `\p{Cs}`
// solo matchea los no apareados).
const PROHIBIDOS = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\p{Cs}]/u;
const TIENE_LETRA = /\p{L}/u;
const SEPARADORES_TELEFONO = /[\p{Zs}\-()+]/gu;
const TELEFONO_SOLO_DIGITOS = new RegExp(`^[0-9]{${TELEFONO_DIGITOS_MIN},${TELEFONO_DIGITOS_MAX}}$`);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const puntosDeCodigo = (s: string): number => [...s].length;

export type ResultadoNombre =
  | { ok: true; nombre: string }
  | { ok: false; codigo: "requerido" | "formato" | "largo" };

/**
 * Regla del nombre y apellido (RFC 3.2.1), en este orden:
 * 1. falta -> `requerido`; no string -> `formato`.
 * 2. NFC + recorte; vacio -> `requerido`.
 * 3. CR/LF, `Cc`, U+2028/9, bidi, sustitutos sueltos -> `formato`;
 *    espacios internos colapsados a uno.
 * 4. Largo en puntos de codigo: `> 80` -> `largo`; `< 2` -> `formato`.
 * 5. Al menos una letra `\p{L}`; no se exige mas de una palabra.
 */
export function validarNombre(valor: unknown): ResultadoNombre {
  if (valor === undefined) return { ok: false, codigo: "requerido" };
  if (typeof valor !== "string") return { ok: false, codigo: "formato" };
  const recortado = valor.normalize("NFC").trim();
  if (recortado === "") return { ok: false, codigo: "requerido" };
  if (PROHIBIDOS.test(recortado)) return { ok: false, codigo: "formato" };
  const nombre = recortado.replace(/\s+/gu, " ");
  const largo = puntosDeCodigo(nombre);
  if (largo > NOMBRE_MAX) return { ok: false, codigo: "largo" };
  if (largo < NOMBRE_MIN) return { ok: false, codigo: "formato" };
  if (!TIENE_LETRA.test(nombre)) return { ok: false, codigo: "formato" };
  return { ok: true, nombre };
}

export type ResultadoTelefono =
  | { ok: true; telefono: string }
  | { ok: false; codigo: "requerido" | "formato" };

/**
 * Regla del telefono (RFC 3.2, identica a `ux.md`): obligatorio, 8..15
 * digitos ASCII tras quitar espacios, `-`, `(`, `)` y `+`. Rechaza `Cc`
 * (CR/LF/tab) y controles bidi. Devuelve el valor recortado, tal cual lo
 * escribio el visitante.
 */
export function validarTelefono(valor: unknown): ResultadoTelefono {
  if (valor === undefined) return { ok: false, codigo: "requerido" };
  if (typeof valor !== "string") return { ok: false, codigo: "formato" };
  const telefono = valor.trim();
  if (telefono === "") return { ok: false, codigo: "requerido" };
  if (PROHIBIDOS.test(telefono)) return { ok: false, codigo: "formato" };
  const resto = telefono.replace(SEPARADORES_TELEFONO, "");
  if (!TELEFONO_SOLO_DIGITOS.test(resto)) return { ok: false, codigo: "formato" };
  return { ok: true, telefono };
}

// --- Estructura -------------------------------------------------------------

const CLAVES_TOP = ["v", "idempotency_key", "form_token", "lineas", "total_visto", "contacto", "sitio_web"];
const CLAVES_CONTACTO = ["nombre", "telefono"];
const CLAVES_LINEA = ["producto_id", "cantidad", "precio_visto"];

const esObjeto = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const tieneClave = (o: Record<string, unknown>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

const hayClaveDesconocida = (o: Record<string, unknown>, permitidas: string[]): boolean =>
  Object.keys(o).some((k) => !permitidas.includes(k));

const esEnteroNoNegativo = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0;

/**
 * Valida un body ya parseado. Orden: honeypot (-> `errores: []`), esquema
 * estricto (`no_permitido`), y luego campo por campo. Acumula errores sin
 * repetir pares `campo`/`codigo`.
 */
export function validateOrder(input: unknown): ResultadoValidacion {
  const invalida = (errores: ErrorOrden[]): ResultadoValidacion => ({
    ok: false,
    motivo: "invalida",
    errores,
  });

  if (!esObjeto(input)) return invalida([{ campo: null, codigo: "formato" }]);

  // Honeypot (6.2): con cualquier contenido, `errores: []`, sin pista.
  if (tieneClave(input, "sitio_web") && input["sitio_web"] !== "" && input["sitio_web"] !== undefined) {
    return invalida([]);
  }

  const errores: ErrorOrden[] = [];
  const err = (campo: CampoOrden | null, codigo: CodigoError): void => {
    if (!errores.some((e) => e.campo === campo && e.codigo === codigo)) errores.push({ campo, codigo });
  };

  // Esquema estricto (AC-17): to/cc/bcc/webhook/canal/email/... -> no_permitido.
  if (hayClaveDesconocida(input, CLAVES_TOP)) err(null, "no_permitido");

  if (input["v"] !== 1) err(null, "formato");

  const key = input["idempotency_key"];
  if (typeof key !== "string" || !UUID_V4.test(key)) err(null, "formato");

  // `form_token`: solo forma. Firma y ventana de validez son de B7.
  const token = input["form_token"];
  if (token === undefined) err("form_token", "requerido");
  else if (typeof token !== "string" || token === "" || token.length > 512 || PROHIBIDOS.test(token)) {
    err("form_token", "formato");
  }

  // Lineas
  const lineas = input["lineas"];
  if (lineas === undefined) err("lineas", "requerido");
  else if (!Array.isArray(lineas)) err("lineas", "formato");
  else if (lineas.length === 0) err("lineas", "requerido");
  else {
    if (lineas.length > MAX_LINEAS) err("lineas", "largo");
    const vistos = new Set<string>();
    for (const l of lineas.slice(0, MAX_LINEAS + 1) as unknown[]) {
      if (!esObjeto(l)) {
        err("lineas", "formato");
        continue;
      }
      if (hayClaveDesconocida(l, CLAVES_LINEA)) err(null, "no_permitido");
      const id = l["producto_id"];
      if (typeof id !== "string" || id === "" || id.length > 64 || PROHIBIDOS.test(id)) {
        err("lineas", "formato");
      } else if (vistos.has(id)) {
        err("lineas", "formato");
      } else vistos.add(id);
      const c = l["cantidad"];
      if (!esEnteroNoNegativo(c) || c < CANTIDAD_MIN || c > CANTIDAD_MAX) err("lineas", "formato");
      if (!esEnteroNoNegativo(l["precio_visto"])) err("lineas", "formato");
    }
  }

  const total = input["total_visto"];
  if (total === undefined) err("total_visto", "requerido");
  else if (!esEnteroNoNegativo(total)) err("total_visto", "formato");

  // Contacto: solo { nombre, telefono }; email/direccion/localidad -> no_permitido.
  const contacto = input["contacto"];
  let nombreRes: ResultadoNombre;
  let telRes: ResultadoTelefono;
  if (esObjeto(contacto)) {
    if (hayClaveDesconocida(contacto, CLAVES_CONTACTO)) err(null, "no_permitido");
    nombreRes = validarNombre(contacto["nombre"]);
    telRes = validarTelefono(contacto["telefono"]);
  } else {
    const codigo = contacto === undefined ? "requerido" : "formato";
    nombreRes = { ok: false, codigo };
    telRes = { ok: false, codigo };
  }
  if (!nombreRes.ok) err("contacto.nombre", nombreRes.codigo);
  if (!telRes.ok) err("contacto.telefono", telRes.codigo);

  if (errores.length > 0 || !nombreRes.ok || !telRes.ok) return invalida(errores);

  const orden: OrdenValida = {
    v: 1,
    idempotency_key: key as string,
    form_token: token as string,
    lineas: (lineas as Array<Record<string, unknown>>).map((l) => ({
      producto_id: l["producto_id"] as string,
      cantidad: l["cantidad"] as number,
      precio_visto: l["precio_visto"] as number,
    })),
    total_visto: total as number,
    contacto: { nombre: nombreRes.nombre, telefono: telRes.telefono },
  };
  return { ok: true, orden };
}

/**
 * Entrada del handler: tamano (bytes, 16 KB) -> JSON -> `validateOrder`.
 * Nunca incluye el contenido del body en el resultado.
 */
export function validateRawBody(raw: string | Uint8Array): ResultadoValidacion {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes > MAX_BODY_BYTES) return { ok: false, motivo: "demasiado_grande" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch {
    return { ok: false, motivo: "json_invalido" };
  }
  return validateOrder(parsed);
}
