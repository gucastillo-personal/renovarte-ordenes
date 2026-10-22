/**
 * Entrada de la Lambda `orders-http` (B15): arma los adaptadores reales.
 *
 * AVISO: los adaptadores de `src/adapters/` NO estan probados contra AWS
 * real (solo con clientes fake); el smoke real es B19. La configuracion
 * viene de env vars (nombres de parametros, no valores): ver RFC 13.
 * Falta una env var -> la init falla y la Function URL no acepta nada.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { cargarSecretosSsm, crearClienteSdkSsm } from "../adapters/ssm.js";
import { crearClienteSdkSes, crearClienteSes } from "../adapters/ses.js";
import { crearStoresDynamo } from "../adapters/dynamo.js";
import { createCatalog, type FetchLike } from "../lib/catalog.js";
import { crearLectorControl } from "../lib/control.js";
import { crearDiscordWebhook } from "../lib/discord/webhook.js";
import { configLedgerDesdeEnv } from "../lib/ledger.js";
import { crearLogger } from "../lib/log.js";
import { crearSesSender } from "../lib/mail/ses-sender.js";
import { umbralesDesdeEnv } from "../lib/rate-limit.js";
import { crearHandlerHttp, type ContextoHttp, type DepsHttp, type EventoHttp, type RespuestaHttp } from "./http.js";

type Env = Readonly<Record<string, string | undefined>>;

function requerida(env: Env, nombre: string): string {
  const v = env[nombre];
  if (v === undefined || v.trim() === "") throw new Error(`config ausente: ${nombre}`);
  return v;
}

export function construirDepsHttp(env: Env): DepsHttp {
  const region = env["AWS_REGION"];
  const ahora = (): number => Date.now();
  const logger = crearLogger((linea) => console.log(linea), ahora);
  const tabla = requerida(env, "ORDERS_TABLE");
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(region !== undefined ? { region } : {}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const stores = crearStoresDynamo(doc, tabla, ahora);
  const control = crearLectorControl({ store: stores.control, ahora });
  const ssm = crearClienteSdkSsm(region);
  const nombres = { hmac: requerida(env, "HMAC_SECRET_PARAM"), webhook: requerida(env, "DISCORD_WEBHOOK_PARAM") };

  return {
    allowedOrigins: requerida(env, "ALLOWED_ORIGINS")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
    ahora,
    logger,
    cargarSecretos: () => cargarSecretosSsm(ssm, nombres),
    catalogo: createCatalog({
      url: requerida(env, "CATALOG_PRODUCTS_URL"),
      fetch: ((url, init) => fetch(url, init)) as FetchLike,
      now: ahora,
    }),
    control,
    rate: { store: stores.rateLimit, umbrales: umbralesDesdeEnv(env), ahora, logger },
    idem: { store: stores.idempotencia, ahora },
    numeroStore: stores.numero,
    ledger: { store: stores.ledger, control, config: configLedgerDesdeEnv(env), ahora },
    mail: crearSesSender(crearClienteSes(crearClienteSdkSes(region)), {
      destinatario: requerida(env, "ORDER_RECIPIENT_EMAIL"),
      remitente: requerida(env, "ORDER_SENDER_EMAIL"),
    }),
    crearDiscord: (urlWebhook) =>
      crearDiscordWebhook({
        urlWebhook,
        fetch: ((url, init) => fetch(url, init)) as Parameters<typeof crearDiscordWebhook>[0]["fetch"],
        esperar: (ms) => new Promise((r) => setTimeout(r, ms)),
      }),
  };
}

let instancia: ReturnType<typeof crearHandlerHttp> | undefined;

/** Lambda handler. Init perezosa para que importar el modulo no requiera env. */
export async function handler(evento: EventoHttp, contexto?: ContextoHttp): Promise<RespuestaHttp> {
  instancia ??= crearHandlerHttp(construirDepsHttp(process.env));
  return instancia(evento, contexto);
}
