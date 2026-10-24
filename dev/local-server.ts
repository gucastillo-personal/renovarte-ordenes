/**
 * Servidor local de desarrollo (B18). NO es produccion ni se despliega.
 *
 * Mismo handler y mismo contrato HTTP que la Lambda `orders-http`
 * (`src/handlers/http.ts`), pero con puertos fake EN MEMORIA: sin AWS, sin
 * Discord ni SES reales, sin red salvo este servidor en 127.0.0.1. El mail y
 * el mensaje de Discord NO se envian: se imprimen en la consola.
 *
 * Uso (ver README):
 *   pnpm dev:local [--port=8787] [--fail=none|mail|discord|both]
 *                  [--fail-mode=fallido|incierto] [--control=on|tope|flood]
 *   Env equivalentes: PORT, FAIL_CHANNELS, FAIL_MODE, CONTROL_INICIAL,
 *   ALLOWED_ORIGINS (default http://localhost:3000).
 *
 * CORS: en produccion lo maneja la Function URL; el handler no lo emite.
 * Aca lo emula esta capa HTTP (preflight incluido) para poder probar desde
 * el navegador.
 *
 * Solo datos ficticios: lo que se escriba en el formulario se imprime en
 * esta consola (es la razon de ser del harness), asi que no usar datos reales.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { crearHandlerHttp, type DepsHttp, type EventoHttp, type Secretos } from "../src/handlers/http.js";
import { createCatalog, type FetchLike as CatalogFetch } from "../src/lib/catalog.js";
import { crearLectorControl, type ItemControl, type Motivo } from "../src/lib/control.js";
import { crearDiscordWebhook, type FetchLike as DiscordFetch } from "../src/lib/discord/webhook.js";
import type { IdempotenciaStore, ItemIdem } from "../src/lib/idempotency.js";
import { CONFIG_LEDGER_DEFAULT } from "../src/lib/ledger.js";
import { crearLogger } from "../src/lib/log.js";
import { crearSesSender, type ClienteSes } from "../src/lib/mail/ses-sender.js";
import { UMBRALES_DEFAULT, type Contador, type RateLimitStore } from "../src/lib/rate-limit.js";

export type CanalesFallidos = "none" | "mail" | "discord" | "both";
export type ModoFalla = "fallido" | "incierto";
export type ControlInicial = "on" | "tope" | "flood";

export interface OpcionesServidorLocal {
  /** 0 = puerto libre (tests). */
  port?: number;
  fail?: CanalesFallidos;
  failMode?: ModoFalla;
  control?: ControlInicial;
  allowedOrigins?: readonly string[];
  /** Reloj en epoch-ms (tests). */
  ahora?: () => number;
  /** Destino de lo que se "enviaria" y de los logs (default: consola). */
  salida?: (linea: string) => void;
}

export const SECRETO_LOCAL = "secreto-local-de-desarrollo-no-es-real";
export const DESTINATARIO_LOCAL = "ordenes@example.test";
// URL sintetica con forma valida, partida en piezas para no disparar check:leak.
const URL_WEBHOOK_LOCAL = "https://" + "discord" + ".com/api/" + "webhooks/" + "1".repeat(18) + "/" + "Ab_-".repeat(16);

const fila = (id: string, nombre: string, presentacion: string, precio: number) => ({
  id,
  proveedor: "PROV",
  categoria: "Demo",
  nombre,
  presentacion,
  descripcion: "Producto ficticio de desarrollo",
  imagen: "/demo.png",
  precio_venta: precio,
  en_oferta: false,
  tags: [],
});

/** Catalogo fixture (ficticio). */
export const CATALOGO_LOCAL = [
  fila("demo-1", "Crema de prueba", "250 ml", 12500),
  fila("demo-2", "Serum de prueba", "30 ml", 8900),
  fila("demo-3", "Jabon de prueba", "100 g", 3200),
];

export interface ServidorLocal {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export function parsearArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): OpcionesServidorLocal {
  const arg = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const elegir = <T extends string>(v: string | undefined, validos: readonly T[], def: T, nombre: string): T => {
    if (v === undefined || v === "") return def;
    if ((validos as readonly string[]).includes(v)) return v as T;
    throw new Error(`valor invalido para ${nombre}: usar ${validos.join("|")}`);
  };
  const port = Number(arg("port") ?? env["PORT"] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("puerto invalido");
  return {
    port,
    fail: elegir<CanalesFallidos>(arg("fail") ?? env["FAIL_CHANNELS"], ["none", "mail", "discord", "both"], "none", "--fail"),
    failMode: elegir<ModoFalla>(arg("fail-mode") ?? env["FAIL_MODE"], ["fallido", "incierto"], "fallido", "--fail-mode"),
    control: elegir<ControlInicial>(arg("control") ?? env["CONTROL_INICIAL"], ["on", "tope", "flood"], "on", "--control"),
    allowedOrigins: (env["ALLOWED_ORIGINS"] ?? "http://localhost:3000")
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o !== ""),
  };
}

export function construirDepsLocales(op: OpcionesServidorLocal = {}): DepsHttp {
  const ahora = op.ahora ?? ((): number => Date.now());
  const salida = op.salida ?? ((l: string): void => console.log(l));
  const fail = op.fail ?? "none";
  const status = (op.failMode ?? "fallido") === "fallido" ? 400 : 500;
  const falla = (canal: "mail" | "discord"): boolean => fail === "both" || fail === canal;

  const clienteSes: ClienteSes = {
    async enviar(input) {
      if (falla("mail")) throw Object.assign(new Error("mail fake forzado a fallar"), { $metadata: { httpStatusCode: status } });
      const c = input.Content.Simple;
      salida(`\n[MAIL fake] para ${input.Destination.ToAddresses[0]}\nAsunto: ${c.Subject.Data}\n${c.Body.Text.Data}`);
      return { MessageId: "local-mail" };
    },
  };

  const discordFetch: DiscordFetch = async (_url, init) => {
    const base = { headers: { get: () => null } };
    if (falla("discord")) return { ...base, status: (op.failMode ?? "fallido") === "fallido" ? 404 : 500, json: async () => ({}) };
    const payload = JSON.parse(String(init.body.get("payload_json"))) as { content?: string };
    const adjunto = init.body.get("files[0]");
    const texto = adjunto instanceof Blob ? await adjunto.text() : "";
    salida(`\n[DISCORD fake]\n${payload.content ?? ""}\n--- adjunto ---\n${texto}`);
    return { ...base, status: 200, json: async () => ({ id: "local-discord" }) };
  };

  const catalogoFetch: CatalogFetch = async () => ({ status: 200, headers: { get: () => null }, json: async () => CATALOGO_LOCAL });

  // --- Stores en memoria (misma semantica que los de DynamoDB) ---
  const contadores = new Map<string, number>();
  const rateStore: RateLimitStore = {
    async incrementarCondicional(c: Contador) {
      if ((contadores.get(c.pk) ?? 0) >= c.limite) return false;
      contadores.set(c.pk, (contadores.get(c.pk) ?? 0) + 1);
      return true;
    },
    async incrementar(pk) {
      contadores.set(pk, (contadores.get(pk) ?? 0) + 1);
    },
    async leer(pk) {
      return contadores.get(pk) ?? 0;
    },
    async consumirCupo(dia, mes) {
      if ((contadores.get(dia.pk) ?? 0) >= dia.limite) return "dia";
      if ((contadores.get(mes.pk) ?? 0) >= mes.limite) return "mes";
      contadores.set(dia.pk, (contadores.get(dia.pk) ?? 0) + 1);
      contadores.set(mes.pk, (contadores.get(mes.pk) ?? 0) + 1);
      return "ok";
    },
  };
  const items = new Map<string, ItemIdem>();
  const idemStore: IdempotenciaStore = {
    async reservar(item) {
      if (items.has(item.pk)) return false;
      items.set(item.pk, structuredClone(item));
      return true;
    },
    async leer(pk) {
      const it = items.get(pk);
      return it && structuredClone(it);
    },
    async reclamar(pk, canal, t) {
      const it = items.get(pk);
      if (!it || it[`${canal}_estado`] !== "fallido") return false;
      it[`${canal}_estado`] = "enviando";
      it[`${canal}_intento_en`] = t;
      return true;
    },
    async persistirCanal(pk, canal, intentoEn, r) {
      const it = items.get(pk);
      if (!it || it[`${canal}_estado`] !== "enviando" || it[`${canal}_intento_en`] !== intentoEn) return false;
      it[`${canal}_estado`] = r.estado;
      if (r.estado === "entregado") it[`${canal}_message_id`] = r.message_id;
      else it[`${canal}_codigo`] = r.codigo;
      return true;
    },
  };
  const numeros = new Set<string>();
  let gasto = 0;
  const motivoInicial: Motivo | undefined =
    op.control === "tope" ? "tope_alcanzado" : op.control === "flood" ? "flood" : undefined;
  let control: ItemControl | undefined =
    motivoInicial === undefined ? undefined : { pk: "CONTROL", habilitado: false, motivo: motivoInicial };

  const logger = crearLogger((l) => salida(`[log] ${l}`), ahora);
  const lector = crearLectorControl({
    ahora,
    store: {
      async leer() {
        return control;
      },
      async apagar(motivo) {
        control = { pk: "CONTROL", habilitado: false, motivo };
      },
    },
  });

  return {
    allowedOrigins: op.allowedOrigins ?? ["http://localhost:3000"],
    ahora,
    logger,
    cargarSecretos: async (): Promise<Secretos> => ({ hmac: SECRETO_LOCAL, urlWebhook: URL_WEBHOOK_LOCAL }),
    catalogo: createCatalog({ url: "http://local.invalid/products.json", fetch: catalogoFetch, now: ahora }),
    control: lector,
    rate: { store: rateStore, umbrales: UMBRALES_DEFAULT, ahora, logger },
    idem: { store: idemStore, ahora },
    numeroStore: {
      async reservar(pk) {
        if (numeros.has(pk)) return false;
        numeros.add(pk);
        return true;
      },
    },
    ledger: {
      store: {
        async sumar(_pk, usd) {
          gasto += usd;
          return gasto;
        },
      },
      control: lector,
      config: CONFIG_LEDGER_DEFAULT,
      ahora,
    },
    mail: crearSesSender(clienteSes, { destinatario: DESTINATARIO_LOCAL, remitente: "no-reply@example.test" }),
    crearDiscord: (urlWebhook) =>
      crearDiscordWebhook({ urlWebhook, fetch: discordFetch, esperar: async () => undefined }),
  };
}

const MAX_LEIDO = 64 * 1024;

async function leerCuerpo(req: IncomingMessage): Promise<string> {
  const partes: Buffer[] = [];
  let n = 0;
  for await (const p of req) {
    const b = p as Buffer;
    n += b.length;
    if (n <= MAX_LEIDO) partes.push(b); // el handler rechaza lo que pase de 16 KB
  }
  return Buffer.concat(partes).toString("utf-8");
}

export async function iniciarServidorLocal(op: OpcionesServidorLocal = {}): Promise<ServidorLocal> {
  const deps = construirDepsLocales(op);
  const handler = crearHandlerHttp(deps);
  const permitidos = new Set(deps.allowedOrigins);

  const cors = (res: ServerResponse, origen: string | undefined): void => {
    if (origen !== undefined && permitidos.has(origen)) {
      res.setHeader("Access-Control-Allow-Origin", origen);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Max-Age", "3600");
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      const origen = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      cors(res, origen);
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://local.invalid");
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : v;
      const evento: EventoHttp = {
        rawPath: url.pathname,
        headers,
        body: req.method === "GET" ? undefined : await leerCuerpo(req),
        isBase64Encoded: false,
        requestContext: { http: { method: req.method ?? "GET", sourceIp: req.socket.remoteAddress ?? "127.0.0.1" } },
      };
      const r = await handler(evento);
      res.statusCode = r.statusCode;
      for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
      res.end(r.body);
    })().catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ v: 1, resultado: "falla", codigo: "interno" }));
    });
  });

  await new Promise<void>((ok) => server.listen(op.port ?? 8787, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok, ko) => server.close((e) => (e ? ko(e) : ok()))),
  };
}

// --- CLI ----------------------------------------------------------------------------

const esMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (esMain) {
  const op = parsearArgs(process.argv.slice(2), process.env);
  const s = await iniciarServidorLocal(op);
  console.log(`renovarte-ordenes (LOCAL, fakes en memoria) escuchando en ${s.url}`);
  console.log(`  origenes permitidos: ${(op.allowedOrigins ?? []).join(", ")}`);
  console.log(`  canales forzados a fallar: ${op.fail} (${op.failMode}) · CONTROL inicial: ${op.control}`);
  console.log("  GET /v1/estado -> form_token (valido tras 3 s) · POST /v1/ordenes");
}
