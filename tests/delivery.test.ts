import { describe, expect, it } from "vitest";
import { agregar, entregar, type DepsEntrega } from "../src/lib/delivery.js";
import {
  claveIdem,
  resolverIdempotencia,
  type IdempotenciaDeps,
  type IdempotenciaStore,
  type ItemIdem,
  type ResultadoCanal,
  type Canal,
} from "../src/lib/idempotency.js";
import { crearLogger } from "../src/lib/log.js";
import { calcularPayloadHmac } from "../src/lib/payload-hmac.js";
import { NOMBRE, TELEFONO, ordenEntrega } from "./fixtures/orden-entrega.js";

const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const ENT: ResultadoCanal = { estado: "entregado", message_id: "id-1" };
const FALL: ResultadoCanal = { estado: "fallido", codigo: "http_404" };
const INC: ResultadoCanal = { estado: "incierto", codigo: "timeout" };

function fakeStore(opts: { falla?: boolean } = {}): IdempotenciaStore & { items: Map<string, ItemIdem>; ops: string[] } {
  const items = new Map<string, ItemIdem>();
  const ops: string[] = [];
  return {
    items,
    ops,
    async reservar(item) {
      if (items.has(item.pk)) return false;
      items.set(item.pk, structuredClone(item));
      return true;
    },
    async leer(pk) {
      const it = items.get(pk);
      return it && structuredClone(it);
    },
    async reclamar(pk, canal, ahora) {
      const it = items.get(pk);
      if (!it || it[`${canal}_estado`] !== "fallido") return false;
      it[`${canal}_estado`] = "enviando";
      it[`${canal}_intento_en`] = ahora;
      return true;
    },
    async persistirCanal(pk, canal, intentoEn, r) {
      ops.push(`persistir:${canal}:${r.estado}`);
      if (opts.falla) throw new Error("dynamo caido " + NOMBRE);
      const it = items.get(pk);
      if (!it || it[`${canal}_estado`] !== "enviando" || it[`${canal}_intento_en`] !== intentoEn) return false;
      it[`${canal}_estado`] = r.estado;
      if (r.estado === "entregado") it[`${canal}_message_id`] = r.message_id;
      else it[`${canal}_codigo`] = r.codigo;
      return true;
    },
  };
}

function montar(mail: ResultadoCanal | Error, discord: ResultadoCanal | Error, storeOpts = {}) {
  const store = fakeStore(storeOpts);
  const reloj = { t: T0 };
  const idem: IdempotenciaDeps = { store, ahora: () => reloj.t };
  const lineas: string[] = [];
  const logger = crearLogger((l) => lineas.push(l), () => reloj.t);
  const enviados: string[] = [];
  const correr = (r: ResultadoCanal | Error, canal: string) => async () => {
    enviados.push(canal);
    if (r instanceof Error) throw r;
    return r;
  };
  const deps: DepsEntrega = {
    idem,
    mail: { enviar: correr(mail, "mail") },
    discord: { enviar: correr(discord, "discord") },
    logger,
    ahora: () => reloj.t,
    restanteMs: () => 9000,
  };
  return { store, idem, deps, lineas, enviados, reloj };
}

async function reservar(idem: IdempotenciaDeps) {
  const r = await resolverIdempotencia(idem, {
    idempotency_key: KEY,
    payload_hmac: calcularPayloadHmac("secreto-de-prueba", {
      v: 1, idempotency_key: KEY, lineas: [{ producto_id: "a-1", cantidad: 1, precio_visto: 1 }], total_visto: 1,
      contacto: { nombre: NOMBRE, telefono: TELEFONO },
    }),
    asignarNumero: async () => "RA-48271",
  });
  if (r.tipo !== "nueva") throw new Error("esperaba nueva");
  return r;
}

describe("agregar (tabla de 5.3)", () => {
  it.each([
    [[ENT, ENT], "aceptada"],
    [[ENT, FALL], "aceptada"],
    [[FALL, ENT], "aceptada"],
    [[ENT, INC], "aceptada"],
    [[FALL, FALL], "envio_fallido"],
    [[FALL, INC], "envio_fallido"],
    [[INC, FALL], "envio_fallido"],
    [[INC, INC], "estado_incierto"],
    [[FALL], "envio_fallido"],
    [[INC], "estado_incierto"],
    [[ENT], "aceptada"],
  ] as const)("%j -> %s", (rs, esperado) => {
    expect(agregar(rs)).toBe(esperado);
  });
});

describe("entregar: matriz de estados con DynamoDB fake", () => {
  const casos: Array<[string, ResultadoCanal, ResultadoCanal, string]> = [
    ["entregado/entregado", ENT, ENT, "aceptada"],
    ["entregado/fallido", ENT, FALL, "aceptada"],
    ["fallido/entregado", FALL, ENT, "aceptada"],
    ["entregado/incierto", ENT, INC, "aceptada"],
    ["incierto/entregado", INC, ENT, "aceptada"],
    ["fallido/fallido", FALL, FALL, "envio_fallido"],
    ["fallido/incierto", FALL, INC, "envio_fallido"],
    ["incierto/fallido", INC, FALL, "envio_fallido"],
    ["incierto/incierto", INC, INC, "estado_incierto"],
  ];
  it.each(casos)("%s -> %s y persiste cada canal", async (_n, m, d, esperado) => {
    const { store, idem, deps, enviados } = montar(m, d);
    const res = await reservar(idem);
    const out = await entregar(deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: res.canales, intento_en: res.intento_en });
    expect(out.resultado).toBe(esperado);
    expect(out.canales).toEqual({ mail: m, discord: d });
    expect(enviados.sort()).toEqual(["discord", "mail"]);
    const it = store.items.get(claveIdem(KEY))!;
    expect(it.mail_estado).toBe(m.estado);
    expect(it.discord_estado).toBe(d.estado);
  });

  it("canal_fallido por cada canal que no entrego, con orden_aceptada si fue aceptada; sin contenido (AC-26)", async () => {
    const { idem, deps, lineas } = montar(ENT, FALL);
    const res = await reservar(idem);
    await entregar(deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: res.canales, intento_en: res.intento_en });
    expect(lineas).toHaveLength(1);
    const l = JSON.parse(lineas[0]!);
    expect(l).toMatchObject({
      evento: "canal_fallido", canal: "discord", codigo: "http_404", numero_orden: "RA-48271", resultado: "aceptada", orden_aceptada: true,
    });
    expect(lineas.join("\n")).not.toContain(NOMBRE);
    expect(lineas.join("\n")).not.toContain(TELEFONO);
  });

  it("dos canales fallidos -> dos lineas, sin orden_aceptada", async () => {
    const { idem, deps, lineas } = montar(FALL, INC);
    const res = await reservar(idem);
    await entregar(deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: res.canales, intento_en: res.intento_en });
    const ls = lineas.map((l) => JSON.parse(l));
    expect(ls.map((l) => l.canal).sort()).toEqual(["discord", "mail"]);
    expect(ls.every((l) => l.resultado === "envio_fallido" && !("orden_aceptada" in l))).toBe(true);
  });

  it("todo entregado: sin canal_fallido", async () => {
    const { idem, deps, lineas } = montar(ENT, ENT);
    const res = await reservar(idem);
    await entregar(deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: res.canales, intento_en: res.intento_en });
    expect(lineas).toEqual([]);
  });

  it("persiste cada canal apenas termina, antes de que termine el otro (AC-24)", async () => {
    const { idem, deps, store } = montar(ENT, ENT);
    let soltar!: () => void;
    const lento = new Promise<void>((ok) => (soltar = ok));
    deps.discord = { enviar: async () => { await lento; return ENT; } };
    const res = await reservar(idem);
    const p = entregar(deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: res.canales, intento_en: res.intento_en });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.ops).toEqual(["persistir:mail:entregado"]);
    soltar();
    await p;
    expect(store.ops).toEqual(["persistir:mail:entregado", "persistir:discord:entregado"]);
  });

  it("un sender que lanza -> incierto/error_interno, sin perder el otro canal", async () => {
    const { idem, deps, store } = montar(new Error("boom " + NOMBRE), ENT);
    const res = await reservar(idem);
    const out = await entregar(deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: res.canales, intento_en: res.intento_en });
    expect(out.resultado).toBe("aceptada");
    expect(out.canales.mail).toEqual({ estado: "incierto", codigo: "error_interno" });
    expect(store.items.get(claveIdem(KEY))!.mail_estado).toBe("incierto");
  });

  it("falla del store al persistir: el resultado del envio se conserva y el log no lleva el error", async () => {
    const { idem, deps, lineas } = montar(ENT, ENT, { falla: true });
    const res = await reservar(idem);
    const out = await entregar(deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: res.canales, intento_en: res.intento_en });
    expect(out.resultado).toBe("aceptada");
    expect(lineas.some((l) => JSON.parse(l).codigo === "store")).toBe(true);
    expect(lineas.join("\n")).not.toContain(NOMBRE);
  });

  it("condicion perdida (otra request ya cambio el canal): no pisa y avisa", async () => {
    const { idem, deps, store, lineas } = montar(ENT, ENT);
    const res = await reservar(idem);
    store.items.get(claveIdem(KEY))!.mail_intento_en = T0 + 1;
    const out = await entregar(deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: res.canales, intento_en: res.intento_en });
    expect(out.resultado).toBe("aceptada");
    expect(store.items.get(claveIdem(KEY))!.mail_estado).toBe("enviando");
    expect(lineas.some((l) => JSON.parse(l).codigo === "condicion_perdida")).toBe(true);
  });
});

describe("entregar: reintentos y claims concurrentes (AC-24)", () => {
  it("reintento: envia solo el canal fallido reclamado; si entrega -> aceptada", async () => {
    const m = montar(ENT, ENT);
    await reservar(m.idem);
    const it = m.store.items.get(claveIdem(KEY))!;
    it.mail_estado = "fallido";
    it.discord_estado = "incierto";
    const r = await resolverIdempotencia(m.idem, {
      idempotency_key: KEY,
      payload_hmac: it.payload_hmac,
      asignarNumero: async () => "RA-00000",
    });
    expect(r.tipo).toBe("reintento");
    if (r.tipo !== "reintento") return;
    expect(r.canales).toEqual(["mail"]);
    const out = await entregar(m.deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: r.canales, intento_en: r.intento_en });
    expect(m.enviados).toEqual(["mail"]);
    expect(out.resultado).toBe("aceptada");
    expect(out.canales).toEqual({ mail: ENT });
    expect(m.store.items.get(claveIdem(KEY))!.mail_estado).toBe("entregado");
    expect(m.store.items.get(claveIdem(KEY))!.discord_estado).toBe("incierto");
  });

  it("dos reintentos concurrentes: solo uno gana el claim y envia", async () => {
    const m = montar(ENT, ENT);
    await reservar(m.idem);
    const it = m.store.items.get(claveIdem(KEY))!;
    it.mail_estado = "fallido";
    it.discord_estado = "fallido";
    const entrada = { idempotency_key: KEY, payload_hmac: it.payload_hmac, asignarNumero: async () => "RA-00000" };
    const [a, b] = await Promise.all([resolverIdempotencia(m.idem, entrada), resolverIdempotencia(m.idem, entrada)]);
    const ganadores = [a, b].filter((r) => r.tipo === "reintento");
    expect(ganadores).toHaveLength(1);
    const g = ganadores[0]!;
    if (g.tipo !== "reintento") return;
    await entregar(m.deps, { idempotency_key: KEY, orden: ordenEntrega(), canales: g.canales, intento_en: g.intento_en });
    expect(m.enviados.sort()).toEqual(["discord", "mail"]);
    const perdedor = [a, b].find((r) => r.tipo !== "reintento")!;
    expect(perdedor).toEqual({ tipo: "falla", codigo: "en_proceso" });
  });

  it("reintento incierto en el unico canal enviado -> estado_incierto", async () => {
    const m = montar(INC, INC);
    const out = await entregar(m.deps, {
      idempotency_key: KEY, orden: ordenEntrega(), canales: ["discord" as Canal], intento_en: { discord: T0 },
    });
    expect(out.resultado).toBe("estado_incierto");
    expect(m.enviados).toEqual(["discord"]);
  });
});
