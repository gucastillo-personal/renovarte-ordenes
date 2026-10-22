import { describe, expect, it } from "vitest";
import {
  UMBRALES_DEFAULT,
  claveAceptadaDia,
  claveAceptadaHora,
  clavePost,
  consumirCupoGlobal,
  hmacIp,
  registrarAceptada,
  umbralesDesdeEnv,
  verificarRateLimitIp,
  type Contador,
  type RateLimitDeps,
  type RateLimitStore,
} from "../src/lib/rate-limit.js";
import { crearLogger } from "../src/lib/log.js";

const T0 = Date.UTC(2026, 9, 14, 12, 30, 0);
const IP = "203.0.113.77";

function fake(): RateLimitStore & { items: Map<string, { n: number; exp: number }> } {
  const items = new Map<string, { n: number; exp: number }>();
  const inc = (pk: string, exp: number): void => {
    items.set(pk, { n: (items.get(pk)?.n ?? 0) + 1, exp });
  };
  return {
    items,
    async incrementarCondicional(c) {
      if ((items.get(c.pk)?.n ?? 0) >= c.limite) return false;
      inc(c.pk, c.expiraEn);
      return true;
    },
    async incrementar(pk, exp) {
      inc(pk, exp);
    },
    async leer(pk) {
      return items.get(pk)?.n ?? 0;
    },
    async consumirCupo(dia: Contador, mes: Contador) {
      if ((items.get(dia.pk)?.n ?? 0) >= dia.limite) return "dia";
      if ((items.get(mes.pk)?.n ?? 0) >= mes.limite) return "mes";
      inc(dia.pk, dia.expiraEn);
      inc(mes.pk, mes.expiraEn);
      return "ok";
    },
  };
}

function setup(umbrales = UMBRALES_DEFAULT) {
  const store = fake();
  const lineas: string[] = [];
  let t = T0;
  const deps: RateLimitDeps = {
    store,
    umbrales,
    ahora: () => t,
    logger: crearLogger((l) => lineas.push(l), () => t),
  };
  return { store, lineas, deps, avanzar: (ms: number) => (t += ms) };
}

const H = hmacIp("secreto-de-prueba", IP);

describe("hmacIp", () => {
  it("es HMAC hex de 64 chars, determinista, sin la IP en claro", () => {
    expect(H).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacIp("secreto-de-prueba", IP)).toBe(H);
    expect(H).not.toContain(IP);
    expect(hmacIp("otro-secreto", IP)).not.toBe(H);
    expect(hmacIp("secreto-de-prueba", "203.0.113.78")).not.toBe(H);
  });
  it("rechaza secreto o ip vacios", () => {
    expect(() => hmacIp("", IP)).toThrow();
    expect(() => hmacIp("s", "")).toThrow();
  });
});

describe("umbralesDesdeEnv", () => {
  it("usa defaults y toma overrides validos; ignora basura", () => {
    expect(umbralesDesdeEnv({})).toEqual(UMBRALES_DEFAULT);
    const u = umbralesDesdeEnv({ RL_POST_POR_HORA_IP: "5", CUPO_ORDENES_DIA: "abc", CUPO_ORDENES_MES: "0" });
    expect(u.postPorHoraIp).toBe(5);
    expect(u.ordenesPorDia).toBe(50);
    expect(u.ordenesPorMes).toBe(1000);
  });
});

describe("verificarRateLimitIp (AC-19)", () => {
  it("permite 20 POST por hora y el 21 da 429 falla/limite_frecuencia", async () => {
    const { deps } = setup();
    for (let i = 0; i < 20; i++) expect(await verificarRateLimitIp(deps, H)).toEqual({ ok: true });
    const r = await verificarRateLimitIp(deps, H);
    expect(r).toEqual({ ok: false, status: 429, body: { v: 1, resultado: "falla", codigo: "limite_frecuencia" } });
  });

  it("la ventana horaria se reinicia en la hora siguiente", async () => {
    const { deps, avanzar } = setup();
    for (let i = 0; i < 21; i++) await verificarRateLimitIp(deps, H);
    avanzar(3600_000);
    expect(await verificarRateLimitIp(deps, H)).toEqual({ ok: true });
  });

  it("otra IP tiene su propio contador", async () => {
    const { deps } = setup();
    for (let i = 0; i < 21; i++) await verificarRateLimitIp(deps, H);
    expect((await verificarRateLimitIp(deps, hmacIp("secreto-de-prueba", "198.51.100.1"))).ok).toBe(true);
  });

  it("3 aceptadas por hora -> la 4a request recibe 429", async () => {
    const { deps } = setup();
    for (let i = 0; i < 3; i++) {
      expect((await verificarRateLimitIp(deps, H)).ok).toBe(true);
      await registrarAceptada(deps, H);
    }
    const r = await verificarRateLimitIp(deps, H);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(429);
  });

  it("10 aceptadas por dia, repartidas en distintas horas -> 429", async () => {
    const { deps, avanzar } = setup(); // 12:30 UTC
    for (let i = 0; i < 10; i++) {
      expect((await verificarRateLimitIp(deps, H)).ok).toBe(true);
      await registrarAceptada(deps, H);
      avanzar(i % 2 === 0 ? 0 : 3600_000); // 2 por hora como maximo -> bajo el limite horario
    }
    avanzar(3600_000);
    const r = await verificarRateLimitIp(deps, H);
    expect(r.ok).toBe(false);
  });

  it("solo guarda HMAC en las claves y TTL de 24 h; la IP en claro no aparece ni en el log", async () => {
    const { deps, store, lineas } = setup();
    for (let i = 0; i < 21; i++) await verificarRateLimitIp(deps, H);
    await registrarAceptada(deps, H);
    for (const [pk, v] of store.items) {
      expect(pk).not.toContain(IP);
      expect(pk).toContain(H);
      expect(v.exp).toBe(Math.floor(T0 / 1000) + 24 * 3600);
    }
    expect(lineas.length).toBeGreaterThan(0);
    for (const l of lineas) {
      expect(l).not.toContain(IP);
      expect(l).not.toContain(H);
    }
    expect(store.items.has(clavePost(H, T0))).toBe(true);
    expect(store.items.has(claveAceptadaHora(H, T0))).toBe(true);
    expect(store.items.has(claveAceptadaDia(H, T0))).toBe(true);
  });

  it("propaga el error del store", async () => {
    const { deps } = setup();
    deps.store.incrementarCondicional = async () => {
      throw new Error("ddb");
    };
    await expect(verificarRateLimitIp(deps, H)).rejects.toThrow("ddb");
  });
});

describe("consumirCupoGlobal (AC-19)", () => {
  it("50 por dia: la 51 da 503 falla/limite_frecuencia con log de alerta", async () => {
    const { deps, lineas } = setup();
    for (let i = 0; i < 50; i++) expect(await consumirCupoGlobal(deps)).toEqual({ ok: true });
    const r = await consumirCupoGlobal(deps);
    expect(r).toEqual({ ok: false, status: 503, body: { v: 1, resultado: "falla", codigo: "limite_frecuencia" } });
    const log = JSON.parse(lineas[lineas.length - 1]!) as Record<string, unknown>;
    expect(log).toMatchObject({ nivel: "error", evento: "cupo_global_agotado", codigo: "dia", http_status: 503 });
  });

  it("al dia siguiente el cupo diario se renueva, pero cuenta para el mensual", async () => {
    const { deps, avanzar } = setup({ ...UMBRALES_DEFAULT, ordenesPorDia: 2, ordenesPorMes: 3 });
    await consumirCupoGlobal(deps);
    await consumirCupoGlobal(deps);
    expect((await consumirCupoGlobal(deps)).ok).toBe(false);
    avanzar(24 * 3600_000);
    expect((await consumirCupoGlobal(deps)).ok).toBe(true); // 3er del mes
    const r = await consumirCupoGlobal(deps); // tope mensual
    expect(r.ok).toBe(false);
  });

  it("si falla el mensual no consume el diario (atomico) y no hay devolucion", async () => {
    const { deps, store } = setup({ ...UMBRALES_DEFAULT, ordenesPorMes: 1 });
    await consumirCupoGlobal(deps);
    const antes = [...store.items.entries()].map(([k, v]) => [k, v.n]);
    expect((await consumirCupoGlobal(deps)).ok).toBe(false);
    expect([...store.items.entries()].map(([k, v]) => [k, v.n])).toEqual(antes);
  });

  it("el modulo no expone ninguna devolucion de cupo", async () => {
    const m = await import("../src/lib/rate-limit.js");
    expect(Object.keys(m).filter((k) => /devolver|liberar|reembolsar/i.test(k))).toEqual([]);
  });
});
