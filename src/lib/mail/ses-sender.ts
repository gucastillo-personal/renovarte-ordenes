/**
 * Envio del mail por SES v2 (B12; RFC rev. 4 5.3, 10.1; AC-11, AC-17, AC-20).
 *
 * - `Content.Simple` siempre, nunca `Raw`: el nombre no puede inyectar
 *   headers. Sin `ReplyTo` (no hay email del visitante, ADR-0020).
 * - `ToAddresses = [ORDER_RECIPIENT]` y `FromEmailAddress =
 *   ORDER_SENDER_EMAIL`, validados al construir el sender (fallan al
 *   arrancar). Ninguna parte de la orden elige destinatario.
 * - El cliente SES se inyecta (`ClienteSes`). El adaptador real (SDK
 *   `@aws-sdk/client-sesv2`) debe construirse con `maxAttempts:
 *   SES_MAX_ATTEMPTS` (1: un reintento del SDK duplicaria el mail) y un
 *   timeout de `SES_TIMEOUT_MS`; el sender los pasa en cada llamada.
 * - Clasificacion: `MessageId` -> `entregado`; 4xx o error antes de conectar
 *   -> `fallido`; 5xx, timeout, socket cortado, sin `MessageId` o error
 *   desconocido -> `incierto`. Nunca se relanza ni se loguea el error.
 */
import type { OrdenParaEntrega } from "../order-model.js";
import type { ResultadoCanal } from "../idempotency.js";
import { faseDeError, statusDeError } from "../error-red.js";
import { renderMail } from "./render.js";

/** maxAttempts del cliente SES: 1, sin reintentos automaticos. */
export const SES_MAX_ATTEMPTS = 1;
/** Timeout por envio, en ms. */
export const SES_TIMEOUT_MS = 4_000;

/** Forma minima de `SendEmailCommandInput` que usamos (Content.Simple). */
export interface SesEnviarInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: [string] };
  Content: {
    Simple: {
      Subject: { Data: string; Charset: "UTF-8" };
      Body: { Text: { Data: string; Charset: "UTF-8" }; Html: { Data: string; Charset: "UTF-8" } };
    };
  };
}

export interface OpcionesEnvioSes {
  maxAttempts: number;
  timeoutMs: number;
}

/** Cliente inyectado. Resuelve con el `MessageId`; rechaza ante cualquier error. */
export interface ClienteSes {
  enviar(input: SesEnviarInput, opciones: OpcionesEnvioSes): Promise<{ MessageId?: string }>;
}

export interface ConfigSes {
  /** `ORDER_RECIPIENT_EMAIL`. */
  destinatario: string;
  /** `ORDER_SENDER_EMAIL`. */
  remitente: string;
}

export interface SesSender {
  enviar(orden: OrdenParaEntrega): Promise<ResultadoCanal>;
}

// Dirección simple, sin espacios, CR/LF, comas ni angulares (un solo destinatario).
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function validarEmail(valor: string, nombre: string): string {
  if (typeof valor !== "string" || !EMAIL.test(valor)) {
    // No se incluye el valor en el mensaje.
    throw new Error(`config invalida: ${nombre}`);
  }
  return valor;
}

export function crearSesSender(cliente: ClienteSes, config: ConfigSes): SesSender {
  const destinatario = validarEmail(config.destinatario, "ORDER_RECIPIENT_EMAIL");
  const remitente = validarEmail(config.remitente, "ORDER_SENDER_EMAIL");

  return {
    async enviar(orden) {
      const mail = renderMail(orden);
      const input: SesEnviarInput = {
        FromEmailAddress: remitente,
        Destination: { ToAddresses: [destinatario] },
        Content: {
          Simple: {
            Subject: { Data: mail.asunto, Charset: "UTF-8" },
            Body: {
              Text: { Data: mail.texto, Charset: "UTF-8" },
              Html: { Data: mail.html, Charset: "UTF-8" },
            },
          },
        },
      };
      try {
        const r = await cliente.enviar(input, { maxAttempts: SES_MAX_ATTEMPTS, timeoutMs: SES_TIMEOUT_MS });
        const id = r?.MessageId;
        if (typeof id === "string" && id.length > 0) return { estado: "entregado", message_id: id };
        return { estado: "incierto", codigo: "sin_message_id" };
      } catch (err) {
        return clasificarErrorSes(err);
      }
    },
  };
}

export function clasificarErrorSes(err: unknown): ResultadoCanal {
  const status = statusDeError(err);
  if (status !== undefined) {
    if (status >= 400 && status < 500) return { estado: "fallido", codigo: `http_${status}` };
    return { estado: "incierto", codigo: status >= 500 ? `http_${status}` : "http_inesperado" };
  }
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
