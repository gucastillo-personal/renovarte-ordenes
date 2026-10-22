/**
 * Entrega por dos canales (B22; RFC rev. 4 5.3, 5.4 pasos 4-5, 5.5; AC-20,
 * AC-23, AC-24, AC-25).
 *
 * Envia en paralelo (`Promise.allSettled`) solo los canales reclamados por
 * `resolverIdempotencia`; apenas termina cada uno persiste su estado
 * (`registrarCanal`, condicionado a `_intento_en`); agrega segun la tabla de
 * 5.3 y emite `canal_fallido` por cada canal que no entrego (con
 * `orden_aceptada: true` si la orden igual quedo aceptada). No toca el
 * ledger, el rate limit ni el HTTP: eso es del handler (B13-B15).
 *
 * Agregado, sobre los canales enviados en este intento (el canal no enviado
 * de un `reintento` es `incierto` o esta en curso por otra request):
 *   alguno `entregado` -> `aceptada`; si no, alguno `fallido` ->
 *   `envio_fallido`; si no (todo `incierto`) -> `estado_incierto`.
 * Ningun log lleva contenido de la orden: solo codigos y el numero de orden.
 */
import type { OrdenParaEntrega } from "./order-model.js";
import type { Logger } from "./log.js";
import {
  registrarCanal,
  type Canal,
  type IdempotenciaDeps,
  type ResultadoCanal,
} from "./idempotency.js";
import type { SesSender } from "./mail/ses-sender.js";
import type { DiscordSender } from "./discord/webhook.js";

export type ResultadoAgregado = "aceptada" | "envio_fallido" | "estado_incierto";

export interface DepsEntrega {
  idem: IdempotenciaDeps;
  mail: SesSender;
  discord: DiscordSender;
  logger: Logger;
  /** Reloj en epoch-ms (latencia). */
  ahora: () => number;
  /** Ms que le quedan al Lambda. */
  restanteMs: () => number;
}

export interface EntradaEntrega {
  idempotency_key: string;
  orden: OrdenParaEntrega;
  /** Canales reclamados (`nueva`/`reintento`). */
  canales: readonly Canal[];
  /** `intento_en` de cada canal reclamado. */
  intento_en: Partial<Record<Canal, number>>;
}

export interface ResultadoEntrega {
  resultado: ResultadoAgregado;
  canales: Partial<Record<Canal, ResultadoCanal>>;
}

export function agregar(resultados: readonly ResultadoCanal[]): ResultadoAgregado {
  if (resultados.some((r) => r.estado === "entregado")) return "aceptada";
  if (resultados.some((r) => r.estado === "fallido")) return "envio_fallido";
  return "estado_incierto";
}

export async function entregar(deps: DepsEntrega, entrada: EntradaEntrega): Promise<ResultadoEntrega> {
  const { orden } = entrada;
  const canales = [...new Set(entrada.canales)];

  const enviarCanal = async (canal: Canal): Promise<ResultadoCanal> => {
    let r: ResultadoCanal;
    try {
      r = canal === "mail" ? await deps.mail.enviar(orden) : await deps.discord.enviar(orden, deps.restanteMs);
    } catch {
      // Un sender no deberia lanzar; si lo hace, ante la duda es incierto.
      r = { estado: "incierto", codigo: "error_interno" };
    }
    const intentoEn = entrada.intento_en[canal];
    if (intentoEn === undefined) {
      deps.logger.log("error", { evento: "persistencia_canal", canal, codigo: "sin_intento_en", numero_orden: orden.numero_orden });
      return r;
    }
    try {
      const ok = await registrarCanal(deps.idem, entrada.idempotency_key, canal, intentoEn, r);
      if (!ok) {
        deps.logger.log("warn", { evento: "persistencia_canal", canal, codigo: "condicion_perdida", numero_orden: orden.numero_orden });
      }
    } catch {
      // El envio ya ocurrio: no se pierde su resultado por un fallo del store.
      deps.logger.log("error", { evento: "persistencia_canal", canal, codigo: "store", numero_orden: orden.numero_orden });
    }
    return r;
  };

  const inicio = deps.ahora();
  const liquidados = await Promise.allSettled(canales.map(enviarCanal));
  const latencia = deps.ahora() - inicio;

  const porCanal: Partial<Record<Canal, ResultadoCanal>> = {};
  canales.forEach((canal, i) => {
    const l = liquidados[i];
    porCanal[canal] =
      l !== undefined && l.status === "fulfilled" ? l.value : { estado: "incierto", codigo: "error_interno" };
  });

  const resultado = agregar(Object.values(porCanal));
  for (const canal of canales) {
    const r = porCanal[canal];
    if (r === undefined || r.estado === "entregado") continue;
    deps.logger.log("warn", {
      evento: "canal_fallido",
      canal,
      codigo: r.codigo,
      numero_orden: orden.numero_orden,
      resultado,
      latencia_ms: latencia,
      ...(resultado === "aceptada" ? { orden_aceptada: true } : {}),
    });
  }
  return { resultado, canales: porCanal };
}
