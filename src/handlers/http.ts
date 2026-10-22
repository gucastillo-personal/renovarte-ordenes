/**
 * Handler HTTP de la Function URL (B15; RFC rev. 4 3, 5, 6.4, 6.5, 8.4;
 * AC-9, AC-10, AC-13, AC-15, AC-17..AC-20, AC-22..AC-25; ADR-0016, ADR-0020).
 *
 * Une los modulos de `src/lib` sin I/O propio: todo lo externo (DynamoDB,
 * SES, Discord, catalogo, SSM, reloj, logger) entra como puerto en
 * `DepsHttp`, asi la suite de integracion corre con fakes.
 *
 * Rutas (por `rawPath` exacto, payload v2 de la Function URL):
 *   GET  /v1/estado   disponibilidad + `form_token` (sin escrituras)
 *   POST /v1/ordenes  crear la orden
 * Cualquier otro metodo o ruta (incluido OPTIONS) -> 404/405 sin tocar
 * ningun puerto. CORS lo maneja la Function URL: este handler NUNCA emite
 * headers `Access-Control-*` (RFC 6.4). Toda respuesta lleva
 * `Cache-Control: no-store`.
 *
 * Orden de `POST /v1/ordenes` (RFC 6.5):
 *   1. tamano y JSON -> Origin -> flag `CONTROL` (apagado: sin escrituras)
 *   2. rate limit por IP
 *   3. esquema, honeypot, `form_token`, nombre/telefono, `total_visto`
 *   4. key existente (idempotente / claim de canales `fallido`)
 *   5. catalogo (`rechazada_por_catalogo`)
 *   6. cupo global (solo key nueva)
 *   7. reserva de `NUM#` y `IDEM#`
 *   8. envio en paralelo -> persistencia por canal -> agregado -> ledger
 * Los pasos 5-7 viven en el callback `asignarNumero` de
 * `resolverIdempotencia`, que solo se invoca con key nueva: asi respetan el
 * orden del RFC sin que las rutas idempotentes necesiten el catalogo.
 *
 * Decisiones (owner, 2026-10): falla al leer `CONTROL` -> CERRADO (500
 * `interno`, no acepta); `total_visto` inconsistente -> 422 `total_visto`/
 * `formato`; `catalogo_no_disponible` -> 503 sin consumir cupo ni reservar
 * numero.
 *
 * Privacidad: nombre, telefono, IP, body, URL del webhook y mensajes de
 * error NUNCA se loguean ni se persisten (el logger tiene allowlist; los
 * errores se descartan y solo se registra la etapa).
 */
import type { CampoOrden, CrearOrdenResponse, EstadoResponse } from "../wire.js";
import type { CatalogClient, Catalogo } from "../lib/catalog.js";
import { construirOrdenParaEntrega } from "../lib/order-model.js";
import { verificarContraCatalogo, verificarTotalVisto } from "../lib/price-check.js";
import { emitirToken, verificarToken } from "../lib/form-token.js";
import { calcularPayloadHmac } from "../lib/payload-hmac.js";
import { reservarNumero, type NumeroStore } from "../lib/order-number.js";
import {
  registrarCanal,
  resolverIdempotencia,
  type Canal,
  type IdempotenciaDeps,
} from "../lib/idempotency.js";
import { entregar } from "../lib/delivery.js";
import type { SesSender } from "../lib/mail/ses-sender.js";
import type { DiscordSender } from "../lib/discord/webhook.js";
import type { Logger } from "../lib/log.js";
import {
  consumirCupoGlobal,
  hmacIp,
  registrarAceptada,
  verificarRateLimitIp,
  type RateLimitDeps,
} from "../lib/rate-limit.js";
import { registrarGasto, type LedgerDeps } from "../lib/ledger.js";
import { respuestaEstadoApagado, respuestaOrdenApagado, type LectorControl } from "../lib/control.js";
import { MAX_BODY_BYTES, validateOrder, type ErrorOrden } from "../lib/validate-order.js";

// --- Tipos del evento (Function URL, payload v2; subconjunto) ------------------

export interface EventoHttp {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string; sourceIp?: string } };
}

export interface RespuestaHttp {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface ContextoHttp {
  getRemainingTimeInMillis(): number;
}

// --- Puertos --------------------------------------------------------------------

/** Secretos de SSM (ADR-0019), leidos en el cold start. */
export interface Secretos {
  /** `secreto_hmac`: form_token, HMAC de IP y huella del payload. */
  hmac: string;
  /** URL del webhook; `""` si no se pudo cargar (el canal queda `fallido`/`config`). */
  urlWebhook: string;
}

export interface DepsHttp {
  /** `ALLOWED_ORIGINS` ya separado. */
  allowedOrigins: readonly string[];
  /** Reloj en epoch-ms. */
  ahora: () => number;
  logger: Logger;
  /** Lee los dos secretos de SSM en paralelo; rechaza si falta el HMAC. */
  cargarSecretos: () => Promise<Secretos>;
  catalogo: CatalogClient;
  control: LectorControl;
  rate: RateLimitDeps;
  idem: IdempotenciaDeps;
  numeroStore: NumeroStore;
  ledger: LedgerDeps;
  mail: SesSender;
  /** Arma el sender de Discord con la URL de SSM (se memoiza por URL). */
  crearDiscord: (urlWebhook: string) => DiscordSender;
}

/** Cache de secretos incompletos (webhook ausente): se reintenta SSM luego. */
export const SECRETOS_PARCIAL_TTL_MS = 60_000;
/** Sin contexto de Lambda (tests): se asume el timeout configurado de 10 s. */
const RESTANTE_DEFAULT_MS = 10_000;

// --- Respuestas -------------------------------------------------------------------

interface Resp {
  status: number;
  body: CrearOrdenResponse | EstadoResponse;
  numero_orden?: string;
}

const falla = (status: number, codigo: Extract<CrearOrdenResponse, { resultado: "falla" }>["codigo"]): Resp => ({
  status,
  body: { v: 1, resultado: "falla", codigo },
});
const invalida = (status: number, errores: Array<{ campo: CampoOrden | null; codigo: ErrorOrden["codigo"] }>): Resp => ({
  status,
  body: { v: 1, resultado: "invalida", errores },
});
const INTERNO = (): Resp => falla(500, "interno");

/** Error de un paso: solo la etapa; el mensaje original se descarta (puede traer datos). */
class ErrorPaso extends Error {
  constructor(readonly etapa: string) {
    super(etapa);
  }
}

async function en<T>(etapa: string, p: Promise<T> | (() => Promise<T>)): Promise<T> {
  try {
    return await (typeof p === "function" ? p() : p);
  } catch {
    throw new ErrorPaso(etapa);
  }
}

function aRespuesta(r: Resp): RespuestaHttp {
  return {
    statusCode: r.status,
    // Sin `Access-Control-*`: lo maneja la Function URL (RFC 6.4).
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(r.body),
  };
}

function minusculas(h: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

// --- Handler -------------------------------------------------------------------------

export function crearHandlerHttp(deps: DepsHttp): (evento: EventoHttp, contexto?: ContextoHttp) => Promise<RespuestaHttp> {
  let secretosCache: { s: Secretos; hasta: number } | undefined;
  let discordCache: { url: string; sender: DiscordSender } | undefined;

  async function secretos(): Promise<Secretos> {
    const t = deps.ahora();
    if (secretosCache !== undefined && t < secretosCache.hasta) return secretosCache.s;
    const s = await deps.cargarSecretos();
    secretosCache = { s, hasta: s.urlWebhook === "" ? t + SECRETOS_PARCIAL_TTL_MS : Infinity };
    return s;
  }

  function discord(url: string): DiscordSender {
    if (discordCache === undefined || discordCache.url !== url) {
      discordCache = { url, sender: deps.crearDiscord(url) };
    }
    return discordCache.sender;
  }

  async function controlCerrado(): Promise<Awaited<ReturnType<LectorControl["leer"]>>> {
    // Falla al leer CONTROL -> CERRADO: ErrorPaso -> 500 `interno`.
    return en("control", deps.control.leer());
  }

  // --- GET /v1/estado ---------------------------------------------------------------

  async function getEstado(): Promise<Resp> {
    const estado = await controlCerrado();
    const apagado = respuestaEstadoApagado(estado);
    if (apagado !== null) return { status: 200, body: apagado };
    const s = await en("secretos", secretos());
    const form_token = await en("form_token", async () => emitirToken(s.hmac, deps.ahora()));
    return { status: 200, body: { v: 1, resultado: "disponible", form_token } };
  }

  // --- POST /v1/ordenes ----------------------------------------------------------------

  async function postOrdenes(evento: EventoHttp, headers: Record<string, string>, contexto?: ContextoHttp): Promise<Resp> {
    // 1. Tamano y JSON valido.
    const crudo = evento.body ?? "";
    const texto = evento.isBase64Encoded === true ? Buffer.from(crudo, "base64").toString("utf8") : crudo;
    if (Buffer.byteLength(texto, "utf8") > MAX_BODY_BYTES) return invalida(413, []);
    let parsed: unknown;
    try {
      parsed = JSON.parse(texto);
    } catch {
      return invalida(422, []);
    }

    // 1. Origin (independiente de CORS, RFC 6.2).
    const origen = headers["origin"];
    if (origen === undefined || !deps.allowedOrigins.includes(origen)) return falla(403, "origen");

    // 1. Flag de control (cache de 30 s): apagado -> sin escrituras.
    const apagado = respuestaOrdenApagado(await controlCerrado());
    if (apagado !== null) return { status: apagado.status, body: apagado.body };

    // 2. Rate limit por IP.
    const s = await en("secretos", secretos());
    const ip = evento.requestContext.http.sourceIp;
    if (ip === undefined || ip === "") throw new ErrorPaso("sin_ip");
    const ipHmac = hmacIp(s.hmac, ip);
    const rl = await en("rate_limit", verificarRateLimitIp(deps.rate, ipHmac));
    if (!rl.ok) return { status: rl.status, body: rl.body };

    // 3. Esquema, honeypot, token, contacto, total.
    const v = validateOrder(parsed);
    if (!v.ok) {
      if (v.motivo !== "invalida") return invalida(422, []);
      // Token ausente, malformado o ajeno: siempre `token_vencido` (Q-F4).
      const errores: ErrorOrden[] = [];
      for (const e of v.errores) {
        const m: ErrorOrden = e.campo === "form_token" ? { campo: "form_token", codigo: "token_vencido" } : e;
        if (!errores.some((x) => x.campo === m.campo && x.codigo === m.codigo)) errores.push(m);
      }
      for (const e of errores) deps.logger.logValidacion(e.campo ?? "ninguno", e.codigo);
      return invalida(422, errores);
    }
    const orden = v.orden;
    if (!verificarToken(orden.form_token, s.hmac, deps.ahora()).ok) {
      deps.logger.logValidacion("form_token", "token_vencido");
      return invalida(422, [{ campo: "form_token", codigo: "token_vencido" }]);
    }
    if (!verificarTotalVisto(orden.lineas, orden.total_visto)) {
      deps.logger.logValidacion("total_visto", "formato");
      return invalida(422, [{ campo: "total_visto", codigo: "formato" }]);
    }

    const huella = calcularPayloadHmac(s.hmac, orden);

    // 5. Catalogo: una discrepancia fuerza un refetch antes de rechazar (RFC 4.2).
    const validarCatalogo = async (): Promise<{ ok: true; catalogo: Catalogo } | { ok: false; res: Resp }> => {
      const noDisponible = (): { ok: false; res: Resp } => {
        deps.logger.log("error", { evento: "catalogo_no_disponible", resultado: "falla", codigo: "catalogo_no_disponible", http_status: 503 });
        return { ok: false, res: falla(503, "catalogo_no_disponible") };
      };
      let c = await en("catalogo", deps.catalogo.get());
      if (!c.ok) return noDisponible();
      let r = verificarContraCatalogo(orden.lineas, c.catalogo);
      if (!r.ok) {
        c = await en("catalogo", deps.catalogo.forceRefresh());
        if (!c.ok) return noDisponible();
        r = verificarContraCatalogo(orden.lineas, c.catalogo);
      }
      if (!r.ok) {
        deps.logger.log("info", { evento: "rechazada_por_catalogo", resultado: "rechazada_por_catalogo", http_status: 409 });
        return {
          ok: false,
          res: { status: 409, body: { v: 1, resultado: "rechazada_por_catalogo", lineas: r.lineas, total_vigente: r.total_vigente } },
        };
      }
      return { ok: true, catalogo: c.catalogo };
    };

    // 4-7. Idempotencia; catalogo, cupo y numero solo si la key es nueva.
    let previa: Resp | undefined;
    let catalogoNueva: Catalogo | undefined;
    const asignarNumero = async (): Promise<string | null> => {
      const c = await validarCatalogo();
      if (!c.ok) {
        previa = c.res;
        return null;
      }
      const cupo = await consumirCupoGlobal(deps.rate);
      if (!cupo.ok) {
        previa = { status: cupo.status, body: cupo.body };
        return null;
      }
      const n = await reservarNumero({ store: deps.numeroStore });
      if (!n.ok) {
        deps.logger.log("error", { evento: "error_interno", codigo: "numero_orden", http_status: 500 });
        previa = INTERNO();
        return null;
      }
      catalogoNueva = c.catalogo;
      return n.numero;
    };
    const idem = await en("idempotencia", resolverIdempotencia(deps.idem, { idempotency_key: orden.idempotency_key, payload_hmac: huella, asignarNumero }));
    if (previa !== undefined) return previa;

    switch (idem.tipo) {
      case "invalida":
        deps.logger.logValidacion("idempotency_key", "payload_distinto");
        return invalida(422, []);
      case "falla":
        return idem.codigo === "en_proceso" ? falla(503, "en_proceso") : idem.codigo === "estado_incierto" ? falla(502, "estado_incierto") : INTERNO();
      case "aceptada":
        return {
          status: 200,
          body: { v: 1, resultado: "aceptada", numero_orden: idem.numero_orden, recibida_en: idem.recibida_en },
          numero_orden: idem.numero_orden,
        };
      case "nueva":
      case "reintento":
        break;
    }

    // Canales reclamados: si algo falla antes de enviar, se devuelven a `fallido`
    // (reintentables) en vez de dejarlos `enviando` hasta que venzan.
    const liberar = async (codigo: string): Promise<void> => {
      for (const canal of idem.canales) {
        const intento = idem.intento_en[canal];
        if (intento === undefined) continue;
        try {
          await registrarCanal(deps.idem, orden.idempotency_key, canal, intento, { estado: "fallido", codigo });
        } catch {
          deps.logger.log("error", { evento: "persistencia_canal", canal, codigo: "store", numero_orden: idem.numero_orden });
        }
      }
    };

    let catalogo = catalogoNueva;
    if (catalogo === undefined) {
      // Reintento de una key existente: el contenido sale del catalogo vigente.
      let c;
      try {
        c = await validarCatalogo();
      } catch (e) {
        await liberar("catalogo");
        throw e;
      }
      if (!c.ok) {
        await liberar("catalogo");
        return c.res;
      }
      catalogo = c.catalogo;
    }

    const ahora = deps.ahora();
    const construida = construirOrdenParaEntrega({
      numero_orden: idem.numero_orden,
      ahoraMs: ahora,
      contacto: orden.contacto,
      lineas: orden.lineas,
      catalogo,
    });
    if (!construida.ok) {
      await liberar("interno");
      deps.logger.log("error", { evento: "error_interno", codigo: "orden_para_entrega", numero_orden: idem.numero_orden, http_status: 500 });
      return INTERNO();
    }

    // 8. Envio en paralelo + persistencia por canal + agregado.
    const restanteMs = (): number => contexto?.getRemainingTimeInMillis() ?? RESTANTE_DEFAULT_MS;
    const r = await en(
      "entrega",
      entregar(
        { idem: deps.idem, mail: deps.mail, discord: discord(s.urlWebhook), logger: deps.logger, ahora: deps.ahora, restanteMs },
        {
          idempotency_key: orden.idempotency_key,
          orden: construida.orden,
          canales: idem.canales as Canal[],
          intento_en: idem.intento_en,
        },
      ),
    );

    // Ledger por cada request que llego a enviar; contador por IP solo si quedo aceptada.
    // Un fallo aca no deshace una entrega ya hecha: se registra y se responde igual.
    const posteriores: Array<Promise<unknown>> = [
      registrarGasto(deps.ledger, { requests: 1, mails: idem.canales.includes("mail") ? 1 : 0 }),
    ];
    if (r.resultado === "aceptada") posteriores.push(registrarAceptada(deps.rate, ipHmac));
    const liquidados = await Promise.allSettled(posteriores);
    if (liquidados.some((l) => l.status === "rejected")) {
      deps.logger.log("error", { evento: "error_interno", codigo: "ledger_o_contador", numero_orden: idem.numero_orden });
    }

    const numero = idem.numero_orden;
    switch (r.resultado) {
      case "aceptada":
        return {
          status: 201,
          body: { v: 1, resultado: "aceptada", numero_orden: numero, recibida_en: construida.orden.recibida_en },
          numero_orden: numero,
        };
      case "envio_fallido":
        return { ...falla(502, "envio_fallido"), numero_orden: numero };
      case "estado_incierto":
        return { ...falla(502, "estado_incierto"), numero_orden: numero };
    }
  }

  /** `Origin` de `GET /v1/estado` (misma lista que el POST; interpretacion, ver reporte). */
  async function controlOrigen(headers: Record<string, string>, siguiente: () => Promise<Resp>): Promise<Resp> {
    const origen = headers["origin"];
    if (origen === undefined || !deps.allowedOrigins.includes(origen)) return falla(403, "origen");
    return siguiente();
  }

  // --- Entrada ---------------------------------------------------------------------------

  return async function handler(evento, contexto) {
    const inicio = deps.ahora();
    const metodo = evento.requestContext.http.method.toUpperCase();
    const headers = minusculas(evento.headers);
    let res: Resp;
    try {
      if (evento.rawPath === "/v1/estado" && metodo === "GET") {
        res = await controlOrigen(headers, () => getEstado());
      } else if (evento.rawPath === "/v1/ordenes" && metodo === "POST") {
        res = await postOrdenes(evento, headers, contexto);
      } else if (evento.rawPath === "/v1/estado" || evento.rawPath === "/v1/ordenes") {
        res = falla(405, "interno"); // incluye OPTIONS: no se rutea (RFC 6.4)
      } else {
        res = falla(404, "interno");
      }
    } catch (err) {
      // Solo la etapa: el mensaje puede traer datos personales o la URL del webhook.
      const etapa = err instanceof ErrorPaso ? err.etapa : "no_controlado";
      deps.logger.log("error", { evento: "error_interno", codigo: etapa, http_status: 500 });
      res = INTERNO();
    }
    const resultado = "resultado" in res.body ? res.body.resultado : "desconocido";
    deps.logger.log("info", {
      evento: "request",
      resultado,
      http_status: res.status,
      latencia_ms: deps.ahora() - inicio,
      ...(res.numero_orden !== undefined ? { numero_orden: res.numero_orden } : {}),
    });
    return aRespuesta(res);
  };
}
