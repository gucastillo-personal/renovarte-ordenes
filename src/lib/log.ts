/**
 * Logger JSON con allowlist de campos (B10; RFC rev. 4 5.5 y 7; AC-18, AC-26).
 *
 * Toda clave fuera de `CAMPOS_PERMITIDOS` se descarta, y solo pasan valores
 * primitivos (string acotado, numero finito, booleano). Nombre, telefono,
 * contacto, IP, body, URL del webhook y bodies de Discord no estan en la
 * lista, ni su largo. La linea de relleno del mail es una constante del
 * render y no pasa por aca. Un error de validacion se loguea solo con
 * `campo` y `codigo`, nunca el valor (ver `logValidacion`).
 *
 * Modulo puro: el sink y el reloj se inyectan.
 */

export const CAMPOS_PERMITIDOS = [
  "evento",
  "numero_orden",
  "resultado",
  "codigo",
  "canal",
  "campo",
  "http_status",
  "latencia_ms",
  "idempotency_key",
  "orden_aceptada",
] as const;

export type CampoLog = (typeof CAMPOS_PERMITIDOS)[number];
export type Nivel = "info" | "warn" | "error";

const PERMITIDOS: ReadonlySet<string> = new Set(CAMPOS_PERMITIDOS);
const MAX_STRING = 120;

export type Sink = (linea: string) => void;

export interface Logger {
  log(nivel: Nivel, campos: Readonly<Record<string, unknown>>): void;
  /** Error de validacion: solo `campo` y `codigo`; jamas el valor. */
  logValidacion(campo: string, codigo: string): void;
}

export function filtrarCampos(campos: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(campos)) {
    if (!PERMITIDOS.has(k)) continue;
    if (typeof v === "string") out[k] = v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function crearLogger(sink: Sink, ahoraMs: () => number): Logger {
  const log = (nivel: Nivel, campos: Readonly<Record<string, unknown>>): void => {
    sink(JSON.stringify({ ts: new Date(ahoraMs()).toISOString(), nivel, ...filtrarCampos(campos) }));
  };
  return {
    log,
    logValidacion: (campo, codigo) => log("warn", { evento: "validacion", campo, codigo }),
  };
}
