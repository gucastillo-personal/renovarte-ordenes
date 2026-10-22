/**
 * Adaptador SSM (B15; ADR-0019). NO PROBADO CONTRA AWS REAL.
 *
 * Lee en paralelo los dos secretos del cold start. Sin `secreto_hmac` el
 * servicio no puede operar: rechaza (el handler responde `interno`, cerrado).
 * Si falta solo la URL del webhook, devuelve `""`: el canal Discord queda
 * `fallido`/`config` y el mail sigue. Los errores del SDK se descartan: sus
 * mensajes pueden nombrar parametros y nunca deben llegar a un log.
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { Secretos } from "../handlers/http.js";

export interface NombresParametros {
  hmac: string;
  webhook: string;
}

export function crearClienteSdkSsm(region?: string): SSMClient {
  return new SSMClient(region !== undefined ? { region } : {});
}

export async function cargarSecretosSsm(
  client: Pick<SSMClient, "send">,
  nombres: NombresParametros,
): Promise<Secretos> {
  const leer = async (Name: string): Promise<string> => {
    const r = await client.send(new GetParameterCommand({ Name, WithDecryption: true }));
    const v = r.Parameter?.Value;
    if (typeof v !== "string" || v === "") throw new Error("parametro vacio");
    return v;
  };
  const [hmac, webhook] = await Promise.allSettled([leer(nombres.hmac), leer(nombres.webhook)]);
  if (hmac.status !== "fulfilled") throw new Error("ssm: secreto_hmac no disponible");
  return { hmac: hmac.value, urlWebhook: webhook.status === "fulfilled" ? webhook.value : "" };
}
