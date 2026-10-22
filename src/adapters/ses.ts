/**
 * Adaptador SES v2 (B15). NO PROBADO CONTRA AWS REAL (smoke: B19).
 *
 * `maxAttempts: 1` en el cliente: el SDK reintenta 5xx y timeouts por
 * defecto y eso podria duplicar el mail (RFC 5.2). El timeout de 4 s se
 * aplica con `AbortSignal.timeout` por llamada.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SES_MAX_ATTEMPTS, type ClienteSes } from "../lib/mail/ses-sender.js";

export function crearClienteSdkSes(region?: string): SESv2Client {
  return new SESv2Client({ maxAttempts: SES_MAX_ATTEMPTS, ...(region !== undefined ? { region } : {}) });
}

export function crearClienteSes(client: Pick<SESv2Client, "send">): ClienteSes {
  return {
    async enviar(input, opciones) {
      const r = await client.send(new SendEmailCommand(input), {
        abortSignal: AbortSignal.timeout(opciones.timeoutMs),
      });
      return { MessageId: r.MessageId };
    },
  };
}
