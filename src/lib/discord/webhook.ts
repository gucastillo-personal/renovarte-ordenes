/**
 * Envio a Discord por webhook (B22; RFC rev. 4 5.3, 10.2; AC-20, AC-23).
 *
 * - La URL (cargada de SSM en el cold start por el handler) se valida contra
 *   `URL_WEBHOOK_RE`; si no coincide -> `fallido`/`config` sin request.
 * - `POST <url>?wait=true`, multipart (`payload_json` + `files[0]`), con
 *   timeout de `DISCORD_TIMEOUT_MS`. `fetch` y la espera entran por parametro.
 * - 200 con `id` -> `entregado`; 400/401/403/404/413 (y cualquier otro 4xx) o
 *   error antes de conectar -> `fallido`; 429 -> una sola espera si
 *   `retry_after <= 1,5 s` y quedan > 6 s, si no `fallido`; 5xx, timeout,
 *   socket cortado, 2xx sin `id` o cualquier otra cosa -> `incierto`.
 * - La URL y los bodies (enviado o recibido) JAMAS se loguean ni se
 *   relanzan: los errores se mapean a codigos y se descartan.
 */
import type { OrdenParaEntrega } from "../order-model.js";
import type { ResultadoCanal } from "../idempotency.js";
import { faseDeError } from "../error-red.js";
import { renderDiscord } from "./render.js";

export const DISCORD_TIMEOUT_MS = 4_000;
export const REINTENTO_429_MAX_ESPERA_MS = 1_500;
export const REINTENTO_429_MIN_RESTANTE_MS = 6_000;

export const URL_WEBHOOK_RE = /^https:\/\/discord\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{60,80}$/;

export function urlWebhookValida(url: unknown): url is string {
  return typeof url === "string" && URL_WEBHOOK_RE.test(url);
}

export type FetchLike = (
  url: string,
  init: { method: "POST"; body: FormData; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(nombre: string): string | null }; json(): Promise<unknown> }>;

export interface DepsDiscord {
  /** URL de SSM tal cual; se valida aca, nunca se loguea. */
  urlWebhook: string;
  fetch: FetchLike;
  /** Espera inyectada (solo para el reintento de un 429). */
  esperar: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface DiscordSender {
  /** `restanteMs`: milisegundos que le quedan al Lambda (deadline). */
  enviar(orden: OrdenParaEntrega, restanteMs: () => number): Promise<ResultadoCanal>;
}

type Intento = { tipo: "resultado"; r: ResultadoCanal } | { tipo: "429"; esperaMs: number | undefined };

export function crearDiscordWebhook(deps: DepsDiscord): DiscordSender {
  const valida = urlWebhookValida(deps.urlWebhook);
  const timeoutMs = deps.timeoutMs ?? DISCORD_TIMEOUT_MS;

  async function intentar(orden: OrdenParaEntrega): Promise<Intento> {
    const { payload, adjunto } = renderDiscord(orden);
    const body = new FormData();
    body.append("payload_json", JSON.stringify(payload));
    body.append("files[0]", new Blob([adjunto.contenido], { type: "text/plain; charset=utf-8" }), adjunto.filename);
    let res;
    try {
      res = await deps.fetch(`${deps.urlWebhook}?wait=true`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { tipo: "resultado", r: clasificarErrorRed(err) };
    }
    const s = res.status;
    if (s === 429) return { tipo: "429", esperaMs: await leerEspera(res) };
    if (s === 200) {
      try {
        const j = (await res.json()) as { id?: unknown } | null;
        if (j !== null && typeof j === "object" && typeof j.id === "string" && j.id.length > 0) {
          return { tipo: "resultado", r: { estado: "entregado", message_id: j.id } };
        }
      } catch {
        // body ilegible: se descarta sin guardarlo.
      }
      return { tipo: "resultado", r: { estado: "incierto", codigo: "sin_id" } };
    }
    if (s >= 400 && s < 500) return { tipo: "resultado", r: { estado: "fallido", codigo: `http_${s}` } };
    if (s >= 500 && s < 600) return { tipo: "resultado", r: { estado: "incierto", codigo: `http_${s}` } };
    return { tipo: "resultado", r: { estado: "incierto", codigo: "http_inesperado" } };
  }

  return {
    async enviar(orden, restanteMs) {
      if (!valida) return { estado: "fallido", codigo: "config" };
      const primero = await intentar(orden);
      if (primero.tipo === "resultado") return primero.r;
      // 429: no se proceso, es seguro reintentar una sola vez.
      const espera = primero.esperaMs;
      if (espera === undefined || espera > REINTENTO_429_MAX_ESPERA_MS || restanteMs() <= REINTENTO_429_MIN_RESTANTE_MS) {
        return { estado: "fallido", codigo: "http_429" };
      }
      await deps.esperar(espera);
      const segundo = await intentar(orden);
      return segundo.tipo === "resultado" ? segundo.r : { estado: "fallido", codigo: "http_429" };
    },
  };
}

/** `retry_after` (segundos) del body, o `Retry-After` del header; en ms. */
async function leerEspera(res: Awaited<ReturnType<FetchLike>>): Promise<number | undefined> {
  const aMs = (v: unknown): number | undefined => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.ceil(n * 1000) : undefined;
  };
  try {
    const j = (await res.json()) as { retry_after?: unknown } | null;
    const e = aMs(j?.retry_after);
    if (e !== undefined) return e;
  } catch {
    // sin body usable: se prueba el header.
  }
  return aMs(res.headers.get("retry-after"));
}

function clasificarErrorRed(err: unknown): ResultadoCanal {
  switch (faseDeError(err)) {
    case "antes_de_conectar":
      return { estado: "fallido", codigo: "red" };
    case "timeout":
      return { estado: "incierto", codigo: "timeout" };
    case "cortado":
      return { estado: "incierto", codigo: "socket_cortado" };
    default:
      return { estado: "incierto", codigo: "error" };
  }
}
