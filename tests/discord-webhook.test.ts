import { describe, expect, it } from "vitest";
import { crearDiscordWebhook, urlWebhookValida, type FetchLike } from "../src/lib/discord/webhook.js";
import { renderDiscord } from "../src/lib/discord/render.js";
import { NOMBRE, ordenEntrega } from "./fixtures/orden-entrega.js";

// Sintetica: partida en piezas y con IDs generados para no disparar check:leak.
const ID_WH = "7".repeat(18);
const TOKEN = "Ab_-".repeat(16);
const URL_OK = "https://" + "discord" + ".com/api/" + "webhooks/" + ID_WH + "/" + TOKEN;
const MSG_ID = "5".repeat(18);

interface Llamada { url: string; body: FormData; signal: AbortSignal }
function fakeFetch(respuestas: Array<() => Promise<ReturnType<FetchLike> extends Promise<infer R> ? R : never>>) {
  const llamadas: Llamada[] = [];
  const f: FetchLike = async (url, init) => {
    llamadas.push({ url, body: init.body, signal: init.signal });
    const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)]!;
    return r();
  };
  return { f, llamadas };
}
const res = (status: number, json: unknown, headers: Record<string, string> = {}) => async () => ({
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  json: async () => {
    if (json === undefined) throw new Error("sin body");
    return json;
  },
});
const falla = (e: unknown) => async () => Promise.reject(e);

function setup(respuestas: Parameters<typeof fakeFetch>[0], url = URL_OK) {
  const { f, llamadas } = fakeFetch(respuestas);
  const esperas: number[] = [];
  const sender = crearDiscordWebhook({ urlWebhook: url, fetch: f, esperar: async (ms) => void esperas.push(ms) });
  return { sender, llamadas, esperas };
}
const RESTA = () => 9_000;

describe("urlWebhookValida", () => {
  it("acepta la forma esperada", () => expect(urlWebhookValida(URL_OK)).toBe(true));
  it.each([
    ["http", URL_OK.replace("https", "http")],
    ["otro host", URL_OK.replace("discord", "evil-discord")],
    ["con query", URL_OK + "?x=1"],
    ["id corto", URL_OK.replace(ID_WH, "7".repeat(10))],
    ["token corto", URL_OK.replace(TOKEN, "abc")],
    ["con path extra", URL_OK + "/slack"],
    ["vacia", ""],
  ])("rechaza %s", (_n, u) => expect(urlWebhookValida(u)).toBe(false));
  it("rechaza no-strings", () => expect(urlWebhookValida(undefined)).toBe(false));
});

describe("crearDiscordWebhook", () => {
  it("URL invalida -> fallido/config sin request", async () => {
    const { sender, llamadas } = setup([res(200, { id: MSG_ID })], "https://example.test/x");
    expect(await sender.enviar(ordenEntrega(), RESTA)).toEqual({ estado: "fallido", codigo: "config" });
    expect(llamadas).toHaveLength(0);
  });

  it("POST ?wait=true multipart con payload_json y files[0]; 200 con id -> entregado", async () => {
    const { sender, llamadas } = setup([res(200, { id: MSG_ID })]);
    const o = ordenEntrega();
    expect(await sender.enviar(o, RESTA)).toEqual({ estado: "entregado", message_id: MSG_ID });
    expect(llamadas).toHaveLength(1);
    const l = llamadas[0]!;
    expect(l.url).toBe(URL_OK + "?wait=true");
    const { payload, adjunto } = renderDiscord(o);
    expect(JSON.parse(l.body.get("payload_json") as string)).toEqual(payload);
    const file = l.body.get("files[0]") as File;
    expect(file.name).toBe(adjunto.filename);
    expect(await file.text()).toBe(adjunto.contenido);
    expect(l.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([400, 401, 403, 404, 413])("%i -> fallido", async (s) => {
    const { sender, llamadas } = setup([res(s, { message: NOMBRE })]);
    expect(await sender.enviar(ordenEntrega(), RESTA)).toEqual({ estado: "fallido", codigo: `http_${s}` });
    expect(llamadas).toHaveLength(1);
  });

  it.each([500, 502, 503])("%i -> incierto, sin reenviar", async (s) => {
    const { sender, llamadas } = setup([res(s, undefined)]);
    expect(await sender.enviar(ordenEntrega(), RESTA)).toEqual({ estado: "incierto", codigo: `http_${s}` });
    expect(llamadas).toHaveLength(1);
  });

  it("2xx sin id, 204 o body ilegible -> incierto", async () => {
    for (const r of [res(200, {}), res(200, { id: 5 }), res(200, null), res(204, undefined), res(200, undefined)]) {
      const { sender } = setup([r]);
      expect((await sender.enviar(ordenEntrega(), RESTA)).estado).toBe("incierto");
    }
  });

  it("error antes de conectar -> fallido; timeout y socket cortado -> incierto; desconocido -> incierto", async () => {
    const casos: Array<[unknown, object]> = [
      [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), { estado: "fallido", codigo: "red" }],
      [Object.assign(new Error("x"), { name: "TimeoutError" }), { estado: "incierto", codigo: "timeout" }],
      [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), { estado: "incierto", codigo: "socket_cortado" }],
      [new Error(URL_OK), { estado: "incierto", codigo: "error" }],
    ];
    for (const [err, esperado] of casos) {
      const { sender, llamadas } = setup([falla(err)]);
      const r = await sender.enviar(ordenEntrega(), RESTA);
      expect(r).toEqual(esperado);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(llamadas).toHaveLength(1);
    }
  });

  it("timeout real: aborta por la senal a los timeoutMs", async () => {
    const f: FetchLike = (_u, init) =>
      new Promise((_ok, ko) => init.signal.addEventListener("abort", () => ko(init.signal.reason)));
    const sender = crearDiscordWebhook({ urlWebhook: URL_OK, fetch: f, esperar: async () => {}, timeoutMs: 10 });
    expect(await sender.enviar(ordenEntrega(), RESTA)).toEqual({ estado: "incierto", codigo: "timeout" });
  });

  describe("429", () => {
    it("retry_after <= 1,5 s y quedan > 6 s: espera y reintenta una vez -> entregado", async () => {
      const { sender, llamadas, esperas } = setup([res(429, { retry_after: 0.5 }), res(200, { id: MSG_ID })]);
      expect(await sender.enviar(ordenEntrega(), RESTA)).toEqual({ estado: "entregado", message_id: MSG_ID });
      expect(llamadas).toHaveLength(2);
      expect(esperas).toEqual([500]);
    });
    it("acepta Retry-After del header si el body no lo trae", async () => {
      const { sender, esperas } = setup([res(429, undefined, { "retry-after": "1" }), res(200, { id: MSG_ID })]);
      expect((await sender.enviar(ordenEntrega(), RESTA)).estado).toBe("entregado");
      expect(esperas).toEqual([1000]);
    });
    it("retry_after exacto 1,5 s entra", async () => {
      const { sender, llamadas } = setup([res(429, { retry_after: 1.5 }), res(200, { id: MSG_ID })]);
      expect((await sender.enviar(ordenEntrega(), RESTA)).estado).toBe("entregado");
      expect(llamadas).toHaveLength(2);
    });
    it("retry_after > 1,5 s -> fallido sin reintentar ni esperar", async () => {
      const { sender, llamadas, esperas } = setup([res(429, { retry_after: 2 })]);
      expect(await sender.enviar(ordenEntrega(), RESTA)).toEqual({ estado: "fallido", codigo: "http_429" });
      expect(llamadas).toHaveLength(1);
      expect(esperas).toEqual([]);
    });
    it("quedan <= 6 s -> fallido sin reintentar", async () => {
      const { sender, llamadas } = setup([res(429, { retry_after: 0.5 })]);
      expect(await sender.enviar(ordenEntrega(), () => 6_000)).toEqual({ estado: "fallido", codigo: "http_429" });
      expect(llamadas).toHaveLength(1);
    });
    it("sin retry_after legible -> fallido", async () => {
      const { sender, llamadas } = setup([res(429, undefined)]);
      expect((await sender.enviar(ordenEntrega(), RESTA)).estado).toBe("fallido");
      expect(llamadas).toHaveLength(1);
    });
    it("segundo 429 -> fallido; 5xx tras la espera -> incierto; nunca mas de 2 requests", async () => {
      const a = setup([res(429, { retry_after: 0.1 })]);
      expect(await a.sender.enviar(ordenEntrega(), RESTA)).toEqual({ estado: "fallido", codigo: "http_429" });
      expect(a.llamadas).toHaveLength(2);
      const b = setup([res(429, { retry_after: 0.1 }), res(502, undefined)]);
      expect(await b.sender.enviar(ordenEntrega(), RESTA)).toEqual({ estado: "incierto", codigo: "http_502" });
    });
  });

  it("la URL y los bodies no aparecen en ningun resultado ni error", async () => {
    const e = new Error(URL_OK + " " + NOMBRE);
    const { sender } = setup([falla(e)]);
    const r = JSON.stringify(await sender.enviar(ordenEntrega(), RESTA));
    expect(r).not.toContain(TOKEN);
    expect(r).not.toContain(ID_WH);
    expect(r).not.toContain(NOMBRE);
  });
});
