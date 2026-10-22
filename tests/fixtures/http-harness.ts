/**
 * Arnes de integracion para `handlers/http.ts` (B15): modulos reales de
 * `src/lib` sobre puertos fake en memoria (DynamoDB, SES, Discord, catalogo,
 * SSM). Registra cada ESCRITURA (con su contenido serializado), cada log y
 * cada llamada a un canal, para las aserciones de cero-escrituras y de
 * ausencia de datos personales. Valores ficticios (repo publico).
 */
import { randomUUID } from "node:crypto";
import { crearHandlerHttp, type DepsHttp, type EventoHttp, type RespuestaHttp, type Secretos } from "../../src/handlers/http.js";
import { createCatalog, type FetchLike as CatalogFetch } from "../../src/lib/catalog.js";
import { crearLectorControl, type ItemControl } from "../../src/lib/control.js";
import { crearDiscordWebhook, type FetchLike as DiscordFetch } from "../../src/lib/discord/webhook.js";
import { emitirToken } from "../../src/lib/form-token.js";
import type { IdempotenciaStore, ItemIdem } from "../../src/lib/idempotency.js";
import { CONFIG_LEDGER_DEFAULT, type ConfigLedger } from "../../src/lib/ledger.js";
import { crearLogger } from "../../src/lib/log.js";
import { crearSesSender, type ClienteSes, type SesEnviarInput } from "../../src/lib/mail/ses-sender.js";
import type { Contador, RateLimitStore } from "../../src/lib/rate-limit.js";
import { UMBRALES_DEFAULT, type UmbralesRateLimit } from "../../src/lib/rate-limit.js";

export const SECRETO = "secreto-hmac-de-prueba";
export const ORIGEN = "https://catalogo.example.test";
export const DESTINATARIO = "ordenes@example.test";
export const IP = "198.51.100.7";
export const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
/** Los tests emiten el token en T0 y el reloj arranca 10 s despues. */
export const AHORA0 = T0 + 10_000;

export const NOMBRE_CANARIO = "Zoilo Canarión";
export const TELEFONO_CANARIO = "+54 9 11 5550-1234";
export const MARCA_BODY_DISCORD = "marca-body-discord-xyz";

// Sintetica y partida en piezas para no disparar check:leak.
const ID_WH = "7".repeat(18);
const TOKEN_WH = "Ab_-".repeat(16);
export const URL_WEBHOOK = "https://" + "discord" + ".com/api/" + "webhooks/" + ID_WH + "/" + TOKEN_WH;

const fila = (id: string, precio: number, extra: Record<string, unknown> = {}) => ({
  id,
  proveedor: "PROV",
  categoria: "Cat",
  nombre: `Producto ${id}`,
  presentacion: "10 ml",
  descripcion: "d",
  imagen: "/i.png",
  precio_venta: precio,
  en_oferta: false,
  tags: [],
  ...extra,
});
export const CATALOGO_BASE = [fila("A", 20000), fila("B", 1500)];

export type ModoCanal = "ok" | "fallido" | "incierto";

export interface OpcionesArnes {
  umbrales?: Partial<UmbralesRateLimit>;
  ledger?: Partial<ConfigLedger>;
  catalogo?: unknown[];
  catalogoCae?: boolean;
  controlInicial?: ItemControl;
  controlFalla?: boolean;
  secretos?: () => Promise<Secretos>;
  mail?: ModoCanal;
  discord?: ModoCanal;
  /** Retiene los dos canales hasta `liberar()` (concurrencia). */
  retener?: boolean;
}

export function crearArnes(op: OpcionesArnes = {}) {
  const reloj = { t: AHORA0 };
  const logs: string[] = [];
  const writes: Array<{ op: string; data: string }> = [];
  const registrar = (o: string, datos: unknown): void => {
    writes.push({ op: o, data: JSON.stringify(datos) });
  };

  // --- Estado de los canales ---
  const modos = { mail: op.mail ?? "ok", discord: op.discord ?? "ok" };
  const mailInputs: SesEnviarInput[] = [];
  const discordLlamadas: Array<{ url: string; body: FormData }> = [];
  let compuerta: Promise<void> = Promise.resolve();
  let liberar = (): void => undefined;
  if (op.retener) compuerta = new Promise<void>((r) => (liberar = r));

  const clienteSes: ClienteSes = {
    async enviar(input) {
      mailInputs.push(input);
      await compuerta;
      if (modos.mail === "ok") return { MessageId: `msg-${mailInputs.length}` };
      const status = modos.mail === "fallido" ? 400 : 500;
      throw Object.assign(new Error(`ses ${NOMBRE_CANARIO} ${DESTINATARIO}`), { $metadata: { httpStatusCode: status } });
    },
  };
  const discordFetch: DiscordFetch = async (url, init) => {
    discordLlamadas.push({ url, body: init.body });
    await compuerta;
    const base = { headers: { get: () => null } };
    if (modos.discord === "ok") return { ...base, status: 200, json: async () => ({ id: `d-${discordLlamadas.length}`, aviso: MARCA_BODY_DISCORD }) };
    const status = modos.discord === "fallido" ? 404 : 500;
    return { ...base, status, json: async () => ({ message: MARCA_BODY_DISCORD }) };
  };

  // --- Catalogo ---
  const catalogoLlamadas = { n: 0 };
  let filas = op.catalogo ?? CATALOGO_BASE;
  let caido = op.catalogoCae ?? false;
  const catalogoFetch: CatalogFetch = async () => {
    catalogoLlamadas.n++;
    if (caido) throw new Error("catalogo caido");
    return { status: 200, headers: { get: () => null }, json: async () => filas };
  };

  // --- Stores en memoria; toda escritura queda registrada ---
  const contadores = new Map<string, number>();
  const rateStore: RateLimitStore = {
    async incrementarCondicional(c: Contador) {
      registrar("rl.incrementarCondicional", c);
      if ((contadores.get(c.pk) ?? 0) >= c.limite) return false;
      contadores.set(c.pk, (contadores.get(c.pk) ?? 0) + 1);
      return true;
    },
    async incrementar(pk, exp) {
      registrar("rl.incrementar", { pk, exp });
      contadores.set(pk, (contadores.get(pk) ?? 0) + 1);
    },
    async leer(pk) {
      return contadores.get(pk) ?? 0;
    },
    async consumirCupo(dia, mes) {
      registrar("rl.consumirCupo", { dia, mes });
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
      registrar("idem.reservar", item);
      if (items.has(item.pk)) return false;
      items.set(item.pk, structuredClone(item));
      return true;
    },
    async leer(pk) {
      const it = items.get(pk);
      return it && structuredClone(it);
    },
    async reclamar(pk, canal, ahora) {
      registrar("idem.reclamar", { pk, canal, ahora });
      const it = items.get(pk);
      if (!it || it[`${canal}_estado`] !== "fallido") return false;
      it[`${canal}_estado`] = "enviando";
      it[`${canal}_intento_en`] = ahora;
      return true;
    },
    async persistirCanal(pk, canal, intentoEn, r) {
      registrar("idem.persistirCanal", { pk, canal, intentoEn, r });
      const it = items.get(pk);
      if (!it || it[`${canal}_estado`] !== "enviando" || it[`${canal}_intento_en`] !== intentoEn) return false;
      it[`${canal}_estado`] = r.estado;
      if (r.estado === "entregado") it[`${canal}_message_id`] = r.message_id;
      else it[`${canal}_codigo`] = r.codigo;
      return true;
    },
  };
  const numeros = new Set<string>();
  let control: ItemControl | undefined = op.controlInicial;
  const controlLecturas = { n: 0 };
  let gasto = 0;

  const logger = crearLogger((l) => logs.push(l), () => reloj.t);
  const secretosLlamadas = { n: 0 };
  const cargarSecretos =
    op.secretos ??
    (async (): Promise<Secretos> => {
      secretosLlamadas.n++;
      return { hmac: SECRETO, urlWebhook: URL_WEBHOOK };
    });
  const ahora = (): number => reloj.t;
  const lector = crearLectorControl({
    ahora,
    store: {
      async leer() {
        controlLecturas.n++;
        if (op.controlFalla) throw new Error("dynamo caido " + NOMBRE_CANARIO);
        return control;
      },
      async apagar(motivo) {
        registrar("control.apagar", { motivo });
        control = { pk: "CONTROL", habilitado: false, motivo };
      },
    },
  });

  const deps: DepsHttp = {
    allowedOrigins: [ORIGEN],
    ahora,
    logger,
    cargarSecretos,
    catalogo: createCatalog({ url: "https://catalogo.example.test/data/products.json", fetch: catalogoFetch, now: ahora, timeoutMs: 50 }),
    control: lector,
    rate: { store: rateStore, umbrales: { ...UMBRALES_DEFAULT, ...op.umbrales }, ahora, logger },
    idem: { store: idemStore, ahora },
    numeroStore: {
      async reservar(pk) {
        registrar("num.reservar", { pk });
        if (numeros.has(pk)) return false;
        numeros.add(pk);
        return true;
      },
    },
    ledger: {
      store: {
        async sumar(pk, usd, exp) {
          registrar("ledger.sumar", { pk, usd, exp });
          gasto += usd;
          return gasto;
        },
      },
      control: lector,
      config: { ...CONFIG_LEDGER_DEFAULT, ...op.ledger },
      ahora,
    },
    mail: crearSesSender(clienteSes, { destinatario: DESTINATARIO, remitente: "no-reply@example.test" }),
    crearDiscord: (urlWebhook) =>
      crearDiscordWebhook({ urlWebhook, fetch: discordFetch, esperar: async () => undefined }),
  };
  const handler = crearHandlerHttp(deps);

  // --- Helpers de requests ---
  const evento = (
    metodo: string,
    ruta: string,
    o: { body?: unknown; headers?: Record<string, string | undefined>; ip?: string; crudo?: string } = {},
  ): EventoHttp => ({
    rawPath: ruta,
    headers: { origin: ORIGEN, "content-type": "application/json", ...o.headers },
    body: o.crudo ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
    isBase64Encoded: false,
    requestContext: { http: { method: metodo, sourceIp: o.ip ?? IP } },
  });

  const tokenValido = (emitidoEn = T0): string => emitirToken(SECRETO, emitidoEn);

  const cuerpoOrden = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    v: 1,
    idempotency_key: randomUUID(),
    form_token: tokenValido(),
    lineas: [
      { producto_id: "A", cantidad: 2, precio_visto: 20000 },
      { producto_id: "B", cantidad: 1, precio_visto: 1500 },
    ],
    total_visto: 41500,
    contacto: { nombre: NOMBRE_CANARIO, telefono: TELEFONO_CANARIO },
    ...extra,
  });

  const post = (body: unknown, o: { headers?: Record<string, string | undefined>; ip?: string; crudo?: string } = {}): Promise<RespuestaHttp> =>
    handler(evento("POST", "/v1/ordenes", { body, ...o }));
  const get = (o: { headers?: Record<string, string | undefined> } = {}): Promise<RespuestaHttp> =>
    handler(evento("GET", "/v1/estado", o));

  return {
    handler,
    reloj,
    logs,
    writes,
    items,
    contadores,
    mailInputs,
    discordLlamadas,
    catalogoLlamadas,
    controlLecturas,
    secretosLlamadas,
    modos,
    setCatalogo: (f: unknown[]) => void (filas = f),
    setCaido: (v: boolean) => void (caido = v),
    getControl: () => control,
    gasto: () => gasto,
    liberar: () => liberar(),
    evento,
    tokenValido,
    cuerpoOrden,
    post,
    get,
  };
}

export type Arnes = ReturnType<typeof crearArnes>;
export const json = (r: RespuestaHttp): Record<string, unknown> => JSON.parse(r.body) as Record<string, unknown>;
