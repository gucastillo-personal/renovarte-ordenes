import { describe, expect, it } from "vitest";
import {
  ENVIANDO_VENTANA_MS,
  IDEM_TTL_SEGUNDOS,
  claveIdem,
  registrarCanal,
  resolverIdempotencia,
  type Canal,
  type IdempotenciaDeps,
  type IdempotenciaStore,
  type ItemIdem,
  type ResultadoCanal,
} from "../src/lib/idempotency.js";
import { calcularPayloadHmac, type PayloadParaHuella } from "../src/lib/payload-hmac.js";

const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

const payload = (nombre = "Zoe Canario", telefono = "11 5555-0123"): PayloadParaHuella => ({
  v: 1,
  idempotency_key: KEY,
  lineas: [{ producto_id: "a-1", cantidad: 1, precio_visto: 1000 }],
  total_visto: 1000,
  contacto: { nombre, telefono },
});
const huella = (p = payload()): string => calcularPayloadHmac("secreto-de-prueba", p);

/** DynamoDB fake en memoria con las condiciones de B11. */
function fake(): IdempotenciaStore & { items: Map<string, ItemIdem>; ops: string[] } {
  const items = new Map<string, ItemIdem>();
  const ops: string[] = [];
  return {
    items,
    ops,
    async reservar(item) {
      ops.push("reservar");
      if (items.has(item.pk)) return false;
      items.set(item.pk, structuredClone(item));
      return true;
    },
    async leer(pk) {
      const it = items.get(pk);
      return it && structuredClone(it);
    },
    async reclamar(pk, canal, ahora) {
      ops.push(`reclamar:${canal}`);
      const it = items.get(pk);
      if (!it || it[`${canal}_estado`] !== "fallido") return false;
      it[`${canal}_estado`] = "enviando";
      it[`${canal}_intento_en`] = ahora;
      return true;
    },
    async persistirCanal(pk, canal, intentoEn, r: ResultadoCanal) {
      ops.push(`persistir:${canal}`);
      const it = items.get(pk);
      if (!it || it[`${canal}_estado`] !== "enviando" || it[`${canal}_intento_en`] !== intentoEn) return false;
      it[`${canal}_estado`] = r.estado;
      if (r.estado === "entregado") it[`${canal}_message_id`] = r.message_id;
      else it[`${canal}_codigo`] = r.codigo;
      return true;
    },
  };
}

function setup(t = T0) {
  const store = fake();
  const reloj = { t };
  const deps: IdempotenciaDeps = { store, ahora: () => reloj.t };
  let numeros = 0;
  const entrada = (p = payload()) => ({
    idempotency_key: KEY,
    payload_hmac: huella(p),
    asignarNumero: async () => {
      numeros++;
      return "RA-48271";
    },
  });
  return { store, reloj, deps, entrada, numeros: () => numeros };
}

const estados = (s: ReturnType<typeof fake>, mail: ItemIdem["mail_estado"], discord: ItemIdem["discord_estado"]) => {
  const it = s.items.get(claveIdem(KEY))!;
  it.mail_estado = mail;
  it.discord_estado = discord;
};

describe("idempotency (B11, RFC 5.2-5.4, AC-24)", () => {
  it("key nueva: reserva con ambos canales enviando, huella, numero y expira_en en segundos", async () => {
    const { store, deps, entrada } = setup();
    const r = await resolverIdempotencia(deps, entrada());
    expect(r).toEqual({
      tipo: "nueva",
      numero_orden: "RA-48271",
      canales: ["mail", "discord"],
      intento_en: { mail: T0, discord: T0 },
    });
    const it = store.items.get(claveIdem(KEY))!;
    expect(it.mail_estado).toBe("enviando");
    expect(it.discord_estado).toBe("enviando");
    expect(it.payload_hmac).toBe(huella());
    expect(it.numero_orden).toBe("RA-48271");
    expect(it.creado_en).toBe(new Date(T0).toISOString());
    expect(it.expira_en).toBe(Math.floor(T0 / 1000) + IDEM_TTL_SEGUNDOS);
    expect(typeof it.expira_en).toBe("number");
    expect(IDEM_TTL_SEGUNDOS).toBe(90 * 86400);
  });

  it("el item guardado no contiene el nombre ni el telefono", async () => {
    const { store, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    const json = JSON.stringify([...store.items.values()]);
    expect(json).not.toContain("Canario");
    expect(json).not.toContain("Zoe");
    expect(json).not.toContain("5555");
    expect(json).not.toContain("0123");
  });

  it("otro nombre o telefono con la misma key: invalida y sin envios ni claims", async () => {
    const { store, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    estados(store, "fallido", "fallido");
    store.ops.length = 0;
    for (const p of [payload("Zoe Canarias"), payload("Zoe Canario", "11 5555-0124")]) {
      expect(await resolverIdempotencia(deps, entrada(p))).toEqual({ tipo: "invalida" });
    }
    expect(store.ops).toEqual([]);
  });

  it("key existente con un canal entregado: aceptada con el mismo numero, sin enviar", async () => {
    const { store, deps, entrada, numeros } = setup();
    await resolverIdempotencia(deps, entrada());
    estados(store, "entregado", "incierto");
    store.ops.length = 0;
    expect(await resolverIdempotencia(deps, entrada())).toEqual({
      tipo: "aceptada",
      numero_orden: "RA-48271",
      recibida_en: new Date(T0).toISOString(),
    });
    estados(store, "fallido", "entregado");
    expect((await resolverIdempotencia(deps, entrada())).tipo).toBe("aceptada");
    expect(store.ops).toEqual([]);
    expect(numeros()).toBe(1);
  });

  it("fallido/fallido: reclama y reintenta los dos canales", async () => {
    const { store, reloj, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    estados(store, "fallido", "fallido");
    reloj.t = T0 + 5000;
    const r = await resolverIdempotencia(deps, entrada());
    expect(r).toEqual({
      tipo: "reintento",
      numero_orden: "RA-48271",
      canales: ["mail", "discord"],
      intento_en: { mail: T0 + 5000, discord: T0 + 5000 },
    });
  });

  it("fallido/incierto (y al reves): reclama solo el fallido", async () => {
    const { store, reloj, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    estados(store, "fallido", "incierto");
    reloj.t = T0 + 1000;
    const a = await resolverIdempotencia(deps, entrada());
    expect(a).toMatchObject({ tipo: "reintento", canales: ["mail"] });
    estados(store, "incierto", "fallido");
    const b = await resolverIdempotencia(deps, entrada());
    expect(b).toMatchObject({ tipo: "reintento", canales: ["discord"] });
  });

  it("incierto/incierto: estado_incierto, no reintenta nada", async () => {
    const { store, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    estados(store, "incierto", "incierto");
    store.ops.length = 0;
    expect(await resolverIdempotencia(deps, entrada())).toEqual({ tipo: "falla", codigo: "estado_incierto" });
    expect(store.ops).toEqual([]);
  });

  it("enviando < 30 s: en_proceso; >= 30 s: estado_incierto", async () => {
    const { reloj, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    reloj.t = T0 + ENVIANDO_VENTANA_MS - 1;
    expect(await resolverIdempotencia(deps, entrada())).toEqual({ tipo: "falla", codigo: "en_proceso" });
    reloj.t = T0 + ENVIANDO_VENTANA_MS;
    expect(await resolverIdempotencia(deps, entrada())).toEqual({ tipo: "falla", codigo: "estado_incierto" });
  });

  it("fallido + enviando vencido: reclama el fallido igual", async () => {
    const { store, reloj, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    estados(store, "fallido", "enviando");
    reloj.t = T0 + 60_000;
    expect(await resolverIdempotencia(deps, entrada())).toMatchObject({ tipo: "reintento", canales: ["mail"] });
  });

  it("AC-24: dos reintentos concurrentes sobre un canal fallido, gana uno solo", async () => {
    const { store, reloj, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    estados(store, "fallido", "incierto");
    reloj.t = T0 + 1000;
    const [x, y] = await Promise.all([
      resolverIdempotencia(deps, entrada()),
      resolverIdempotencia(deps, entrada()),
    ]);
    const tipos = [x, y].map((r) => (r.tipo === "falla" ? r.codigo : r.tipo)).sort();
    expect(tipos).toEqual(["en_proceso", "reintento"]);
  });

  it("AC-24: dos requests concurrentes con la misma key nueva, una sola reserva gana", async () => {
    const { store, deps, entrada } = setup();
    const [x, y] = await Promise.all([
      resolverIdempotencia(deps, entrada()),
      resolverIdempotencia(deps, entrada()),
    ]);
    expect([x.tipo, y.tipo].filter((t) => t === "nueva")).toHaveLength(1);
    const otro = [x, y].find((r) => r.tipo !== "nueva")!;
    expect(otro).toEqual({ tipo: "falla", codigo: "en_proceso" });
    expect(store.items.size).toBe(1);
  });

  it("si no se puede asignar numero: falla/interno y no se reserva", async () => {
    const { store, deps, entrada } = setup();
    const r = await resolverIdempotencia(deps, { ...entrada(), asignarNumero: async () => null });
    expect(r).toEqual({ tipo: "falla", codigo: "interno" });
    expect(store.items.size).toBe(0);
  });

  it("un error del store se propaga", async () => {
    const { store, deps, entrada } = setup();
    store.leer = async () => {
      throw new Error("boom");
    };
    await expect(resolverIdempotencia(deps, entrada())).rejects.toThrow("boom");
  });

  it("registrarCanal persiste condicionado al intento_en", async () => {
    const { store, deps, entrada } = setup();
    await resolverIdempotencia(deps, entrada());
    const ok = (c: Canal, t: number, r: ResultadoCanal) => registrarCanal(deps, KEY, c, t, r);
    expect(await ok("mail", T0 + 1, { estado: "entregado", message_id: "m-1" })).toBe(false);
    expect(await ok("mail", T0, { estado: "entregado", message_id: "m-1" })).toBe(true);
    expect(await ok("discord", T0, { estado: "fallido", codigo: "http_400" })).toBe(true);
    const it = store.items.get(claveIdem(KEY))!;
    expect(it).toMatchObject({ mail_estado: "entregado", mail_message_id: "m-1", discord_estado: "fallido", discord_codigo: "http_400" });
    expect(await ok("discord", T0, { estado: "entregado", message_id: "m-2" })).toBe(false);
  });

  it("el store no expone borrado", () => {
    expect(Object.keys(fake())).not.toContain("borrar");
  });
});
