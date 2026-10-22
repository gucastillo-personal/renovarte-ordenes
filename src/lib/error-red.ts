/**
 * Clasificacion de errores de red/cliente sin exponer su contenido (B12, B22;
 * RFC rev. 4 5.3, 10.1, 10.2). Los mensajes de error pueden contener la URL
 * del webhook o el destinatario: solo se inspeccionan `name`, `code`,
 * `cause.code` y el status HTTP; nada se devuelve ni se relanza.
 *
 *  - `antes_de_conectar`: la request no llego al servidor -> `fallido`;
 *  - `timeout`: vencio el plazo, puede haberse procesado -> `incierto`;
 *  - `cortado`: socket cortado/reseteado a mitad de camino -> `incierto`;
 *  - `desconocido`: ante la duda, `incierto` (nunca se reenvia).
 */
export type FaseError = "antes_de_conectar" | "timeout" | "cortado" | "desconocido";

const ANTES_DE_CONECTAR = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const CORTADO = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError", "RequestTimeout"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function texto(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function faseDeError(err: unknown): FaseError {
  if (typeof err !== "object" || err === null) return "desconocido";
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  const cause = typeof e.cause === "object" && e.cause !== null ? (e.cause as { code?: unknown; name?: unknown }) : {};
  const codes = [texto(e.code), texto(cause.code)].filter((c): c is string => c !== undefined);
  const names = [texto(e.name), texto(cause.name)].filter((c): c is string => c !== undefined);
  if (names.some((n) => TIMEOUT_NAMES.has(n)) || codes.some((c) => TIMEOUT_CODES.has(c))) return "timeout";
  if (codes.some((c) => CORTADO.has(c))) return "cortado";
  if (codes.some((c) => ANTES_DE_CONECTAR.has(c))) return "antes_de_conectar";
  return "desconocido";
}

/** Status HTTP de un error del SDK (`$metadata.httpStatusCode`) o `statusCode`/`httpStatus`. */
export function statusDeError(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as { $metadata?: { httpStatusCode?: unknown }; statusCode?: unknown; httpStatus?: unknown };
  for (const v of [e.$metadata?.httpStatusCode, e.statusCode, e.httpStatus]) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599) return v;
  }
  return undefined;
}
