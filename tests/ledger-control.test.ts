import { describe, expect, it } from "vitest";
import {
  CONTROL_CACHE_MS,
  aEstadoControl,
  crearLectorControl,
  respuestaEstadoApagado,
  respuestaOrdenApagado,
  type ControlStore,
  type ItemControl,
  type Motivo,
} from "../src/lib/control.js";
import {
  CONFIG_LEDGER_DEFAULT,
  claveLedger,
  configLedgerDesdeEnv,
  registrarGasto,
  umbralCorte,
  type LedgerStore,
} from "../src/lib/ledger.js";

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

function setup(inicial?: ItemControl) {
  let t = T0;
  let item = inicial;
  const ops = { lecturas: 0, escrituras: [] as Motivo[] };
  const controlStore: ControlStore = {
    async leer() {
      ops.lecturas++;
      return item;
    },
    async apagar(motivo) {
      ops.escrituras.push(motivo);
      item = { pk: "CONTROL", habilitado: false, motivo };
    },
  };
  const control = crearLectorControl({ store: controlStore, ahora: () => t });
  const acum = new Map<string, number>();
  const ledgerStore: LedgerStore = {
    async sumar(pk, usd) {
      const v = (acum.get(pk) ?? 0) + usd;
      acum.set(pk, v);
      return v;
    },
  };
  const deps = { store: ledgerStore, control, config: CONFIG_LEDGER_DEFAULT, ahora: () => t };
  return { ops, control, deps, acum, avanzar: (ms: number) => (t += ms), poner: (i?: ItemControl) => (item = i) };
}

describe("control: cache y mapeo (8.4)", () => {
  it("sin item = habilitado; cachea 30 s y relee despues", async () => {
    const { control, ops, avanzar } = setup();
    expect(await control.leer()).toEqual({ habilitado: true });
    await control.leer();
    expect(ops.lecturas).toBe(1);
    avanzar(CONTROL_CACHE_MS - 1);
    await control.leer();
    expect(ops.lecturas).toBe(1);
    avanzar(1);
    await control.leer();
    expect(ops.lecturas).toBe(2);
  });

  it("motivo desconocido o ausente con habilitado=false -> desconocido (fail-safe)", () => {
    expect(aEstadoControl({ pk: "CONTROL", habilitado: false, motivo: "xyz" })).toEqual({ habilitado: false, motivo: "desconocido" });
    expect(aEstadoControl({ pk: "CONTROL", habilitado: false })).toEqual({ habilitado: false, motivo: "desconocido" });
  });

  it.each([
    ["tope_alcanzado", "tope_alcanzado", "tope_alcanzado"],
    ["presupuesto", "tope_alcanzado", "tope_alcanzado"],
    ["flood", "no_disponible", "mantenimiento"],
    ["desconocido", "no_disponible", "mantenimiento"],
    ["manual", "no_disponible", "mantenimiento"],
  ] as const)("motivo %s -> GET %s / POST 503 %s", (motivo, get, post) => {
    const e = aEstadoControl({ pk: "CONTROL", habilitado: false, motivo });
    expect(respuestaEstadoApagado(e)).toEqual({ v: 1, resultado: get });
    const p = respuestaOrdenApagado(e)!;
    expect(p.status).toBe(503);
    expect(p.body).toEqual(
      post === "tope_alcanzado" ? { v: 1, resultado: "tope_alcanzado" } : { v: 1, resultado: "falla", codigo: "mantenimiento" },
    );
  });

  it("habilitado -> sin respuesta de corte", () => {
    expect(respuestaEstadoApagado({ habilitado: true })).toBeNull();
    expect(respuestaOrdenApagado({ habilitado: true })).toBeNull();
  });
});

describe("ledger (AC-22)", () => {
  it("clave por mes UTC", () => {
    expect(claveLedger(Date.UTC(2026, 9, 31, 23, 59))).toBe("LEDGER#2026-10");
    expect(claveLedger(Date.UTC(2026, 10, 1, 0, 0))).toBe("LEDGER#2026-11");
  });

  it("umbral por defecto = 18 USD; suma costos y no corta bajo el umbral", async () => {
    expect(umbralCorte(CONFIG_LEDGER_DEFAULT)).toBeCloseTo(18);
    const { deps, ops } = setup();
    const r = await registrarGasto(deps, { requests: 1, mails: 1 });
    expect(r.gasto_estimado_usd).toBeCloseTo(CONFIG_LEDGER_DEFAULT.costoRequestUsd + CONFIG_LEDGER_DEFAULT.costoMailUsd);
    expect(r.tope_alcanzado).toBe(false);
    expect(ops.escrituras).toEqual([]);
  });

  it("Discord no suma: el costo depende solo de requests y mails", async () => {
    const { deps } = setup();
    const r = await registrarGasto(deps, { requests: 2, mails: 0 });
    expect(r.gasto_estimado_usd).toBeCloseTo(2 * CONFIG_LEDGER_DEFAULT.costoRequestUsd);
  });

  it(">= cap x ratio apaga CONTROL con tope_alcanzado y los POST pasan a 503 tope", async () => {
    const { deps, ops, control } = setup();
    deps.store.sumar = async () => 18;
    const r = await registrarGasto(deps, { requests: 1, mails: 1 });
    expect(r.tope_alcanzado).toBe(true);
    expect(ops.escrituras).toEqual(["tope_alcanzado"]);
    expect(respuestaOrdenApagado(await control.leer())!.body).toEqual({ v: 1, resultado: "tope_alcanzado" });
    await registrarGasto(deps, { requests: 1, mails: 0 });
    expect(ops.escrituras).toEqual(["tope_alcanzado"]); // no reescribe
  });

  it("no pisa un corte previo con otro motivo", async () => {
    const { deps, ops } = setup({ pk: "CONTROL", habilitado: false, motivo: "flood" });
    deps.store.sumar = async () => 19;
    await registrarGasto(deps, { requests: 1, mails: 0 });
    expect(ops.escrituras).toEqual([]);
  });

  it("configLedgerDesdeEnv: overrides validos y fallback ante basura", () => {
    expect(configLedgerDesdeEnv({})).toEqual(CONFIG_LEDGER_DEFAULT);
    const c = configLedgerDesdeEnv({ BUDGET_CAP_USD: "10", BUDGET_STOP_RATIO: "2", COSTO_MAIL_USD: "x" });
    expect(c.budgetCapUsd).toBe(10);
    expect(c.budgetStopRatio).toBe(0.9);
    expect(c.costoMailUsd).toBe(CONFIG_LEDGER_DEFAULT.costoMailUsd);
  });
});
