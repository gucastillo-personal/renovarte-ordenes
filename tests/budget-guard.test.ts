/**
 * budget-guard (B16; AC-22). Mensajes SNS de ejemplo con el formato
 * documentado de AWS Budgets y de CloudWatch (ID de cuenta enmascarado);
 * a contrastar con capturas reales en I9/I10.
 */
import { describe, expect, it } from "vitest";
import {
  clasificarMensaje,
  concurrenciaDesdeEnv,
  construirDepsBudgetGuard,
  crearHandlerBudgetGuard,
  type ConfigBudgetGuard,
  type EventoBudgetGuard,
} from "../src/handlers/budget-guard.js";
import { crearConcurrenciaLambda } from "../src/adapters/lambda.js";
import { crearControlEscritorDynamo, type DocClientLike } from "../src/adapters/dynamo.js";
import { crearLogger } from "../src/lib/log.js";

const BUDGET = "renovarte-ordenes-aws-cost-cap";
const ALARMA = "renovarte-ordenes-flood";
const CUENTA = "X".repeat(12);

const MSG_BUDGET = [
  "AWS Budget Notification October 21, 2026",
  `AWS Account ${CUENTA}`,
  "",
  "Dear AWS Customer,",
  "",
  `You requested that we alert you when the ACTUAL Cost associated with your ${BUDGET} budget is greater than $20.00 for the current month. The ACTUAL Cost associated with this budget is $20.51.`,
].join("\n");

const alarma = (estado: string, nombre = ALARMA): string =>
  JSON.stringify({
    AlarmName: nombre,
    AlarmDescription: "Flood de ordenes",
    AWSAccountId: CUENTA,
    NewStateValue: estado,
    NewStateReason: "Threshold Crossed",
    StateChangeTime: "2026-10-21T12:00:00.000+0000",
    Region: "US East (N. Virginia)",
    AlarmArn: `arn:aws:cloudwatch:us-east-1:${CUENTA}:alarm:${nombre}`,
    OldStateValue: "OK",
    Trigger: { MetricName: "Invocations", Namespace: "AWS/Lambda", Threshold: 200 },
  });

const sns = (...mensajes: unknown[]): EventoBudgetGuard => ({
  Records: mensajes.map((Message) => ({ Sns: { Message } })),
});

function armar(opciones: { concurrencia?: number; fallaControl?: boolean; fallaConc?: boolean } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const config: ConfigBudgetGuard = {
    budgetName: BUDGET,
    floodAlarmName: ALARMA,
    reservedConcurrency: opciones.concurrencia,
  };
  const handler = crearHandlerBudgetGuard({
    config,
    logger: crearLogger((l) => logs.push(l), () => 0),
    control: {
      async apagar(m) {
        calls.push(`control.apagar:${m}`);
        if (opciones.fallaControl) throw new Error("boom");
      },
      async habilitar() {
        calls.push("control.habilitar");
        if (opciones.fallaControl) throw new Error("boom");
      },
    },
    concurrencia: {
      async poner(n) {
        calls.push(`conc.poner:${n}`);
        if (opciones.fallaConc) throw new Error("boom");
      },
      async quitar() {
        calls.push("conc.quitar");
        if (opciones.fallaConc) throw new Error("boom");
      },
    },
  });
  return { handler, calls, logs, config };
}

describe("budget-guard: disparadores", () => {
  it("mensaje de Budget -> presupuesto + concurrency 0", async () => {
    const { handler, calls } = armar();
    expect(await handler(sns(MSG_BUDGET))).toEqual({ accion: "apagado", motivo: "presupuesto" });
    expect(calls.sort()).toEqual(["conc.poner:0", "control.apagar:presupuesto"]);
  });

  it("alarma de flood en ALARM -> flood + concurrency 0", async () => {
    const { handler, calls } = armar();
    expect(await handler(sns(alarma("ALARM")))).toEqual({ accion: "apagado", motivo: "flood" });
    expect(calls.sort()).toEqual(["conc.poner:0", "control.apagar:flood"]);
  });

  it.each(["OK", "INSUFFICIENT_DATA"])("alarma de flood en %s -> se ignora, sin cambios", async (estado) => {
    const { handler, calls } = armar();
    expect(await handler(sns(alarma(estado)))).toEqual({ accion: "ignorado" });
    expect(calls).toEqual([]);
  });

  it.each([
    ["texto que no menciona el budget", "hola"],
    ["JSON de otra alarma", alarma("ALARM", "otra-alarma")],
    ["estado de alarma desconocido", alarma("???")],
    ["JSON sin AlarmName", JSON.stringify({ x: 1 })],
    ["Message no string", 42],
    ["Message ausente", undefined],
  ])("formato desconocido (%s) -> desconocido, apaga igual", async (_n, msg) => {
    const { handler, calls, logs } = armar();
    expect(await handler(sns(msg))).toEqual({ accion: "apagado", motivo: "desconocido" });
    expect(calls.sort()).toEqual(["conc.poner:0", "control.apagar:desconocido"]);
    expect(logs.join("\n")).toContain("formato_desconocido");
  });

  it("evento sin registros ni reset -> desconocido, apaga (fail-safe)", async () => {
    const { handler, calls } = armar();
    await handler({});
    expect(calls.sort()).toEqual(["conc.poner:0", "control.apagar:desconocido"]);
  });

  it("idempotente: repetir el mismo disparador repite las mismas escrituras", async () => {
    const { handler, calls } = armar();
    await handler(sns(MSG_BUDGET));
    await handler(sns(MSG_BUDGET));
    expect(calls.filter((c) => c === "conc.poner:0")).toHaveLength(2);
  });

  it("varios registros: un OK no tapa un disparador", async () => {
    const { handler } = armar();
    expect(await handler(sns(alarma("OK"), MSG_BUDGET))).toEqual({ accion: "apagado", motivo: "presupuesto" });
  });

  it("si falla CONTROL igual intenta la concurrency y relanza", async () => {
    const { handler, calls } = armar({ fallaControl: true });
    await expect(handler(sns(MSG_BUDGET))).rejects.toThrow();
    expect(calls).toContain("conc.poner:0");
  });

  it("si falla la concurrency relanza (SNS reintenta)", async () => {
    const { handler } = armar({ fallaConc: true });
    await expect(handler(sns(MSG_BUDGET))).rejects.toThrow();
  });

  it("no loguea el mensaje SNS (cuenta ni ARN)", async () => {
    const { handler, logs } = armar();
    await handler(sns(MSG_BUDGET));
    await handler(sns(alarma("ALARM")));
    const todo = logs.join("\n");
    expect(todo).not.toContain(CUENTA);
    expect(todo).not.toContain("arn:");
    expect(todo).not.toContain(BUDGET);
  });
});

describe("budget-guard: clasificarMensaje con nombres vacios", () => {
  it("BUDGET_NAME vacio no matchea cualquier texto como presupuesto", () => {
    const c = clasificarMensaje("cualquier cosa", { budgetName: "", floodAlarmName: "", reservedConcurrency: undefined });
    expect(c).toEqual({ tipo: "apagar", motivo: "desconocido" });
  });
});

describe("budget-guard: reset", () => {
  it("con n -> CONTROL habilitado y luego Put(n)", async () => {
    const { handler, calls } = armar({ concurrencia: 5 });
    expect(await handler({ mode: "reset" })).toEqual({ accion: "reset" });
    expect(calls).toEqual(["control.habilitar", "conc.poner:5"]);
  });

  it("sin n -> CONTROL habilitado y luego Delete", async () => {
    const { handler, calls } = armar();
    await handler({ mode: "reset" });
    expect(calls).toEqual(["control.habilitar", "conc.quitar"]);
  });

  it("si falla CONTROL no toca la concurrency (sigue cerrado)", async () => {
    const { handler, calls } = armar({ concurrencia: 5, fallaControl: true });
    await expect(handler({ mode: "reset" })).rejects.toThrow();
    expect(calls).toEqual(["control.habilitar"]);
  });

  it("n = 0 es un valor valido (Put(0)), no 'vacio'", async () => {
    const { handler, calls } = armar({ concurrencia: 0 });
    await handler({ mode: "reset" });
    expect(calls).toEqual(["control.habilitar", "conc.poner:0"]);
  });
});

describe("budget-guard: config y adaptadores", () => {
  it("concurrenciaDesdeEnv: vacia, numerica e invalida", () => {
    expect(concurrenciaDesdeEnv({})).toBeUndefined();
    expect(concurrenciaDesdeEnv({ ORDERS_HTTP_RESERVED_CONCURRENCY: " " })).toBeUndefined();
    expect(concurrenciaDesdeEnv({ ORDERS_HTTP_RESERVED_CONCURRENCY: "5" })).toBe(5);
    expect(() => concurrenciaDesdeEnv({ ORDERS_HTTP_RESERVED_CONCURRENCY: "cinco" })).toThrow();
  });

  it("construirDeps exige las env vars", () => {
    expect(() => construirDepsBudgetGuard({})).toThrow(/ORDERS_TABLE/);
    const env = {
      ORDERS_TABLE: "t",
      ORDERS_HTTP_FUNCTION_NAME: "f",
      BUDGET_NAME: BUDGET,
      FLOOD_ALARM_NAME: ALARMA,
      ORDERS_HTTP_RESERVED_CONCURRENCY: "",
    };
    expect(construirDepsBudgetGuard(env).config.reservedConcurrency).toBeUndefined();
    expect(() => construirDepsBudgetGuard({ ...env, FLOOD_ALARM_NAME: "" })).toThrow(/FLOOD_ALARM_NAME/);
  });

  it("adaptador Lambda: Put/Delete con la forma del comando; errores sin detalle", async () => {
    const cmds: Array<{ constructor: { name: string }; input: unknown }> = [];
    let falla = false;
    const client = {
      send: async (c: (typeof cmds)[number]) => {
        cmds.push(c);
        if (falla) throw new Error(`arn:aws:lambda:us-east-1:${CUENTA}:function:x`);
        return {};
      },
    } as unknown as Parameters<typeof crearConcurrenciaLambda>[0];
    const c = crearConcurrenciaLambda(client, "fn");
    await c.poner(3);
    await c.quitar();
    expect(cmds[0]!.constructor.name).toBe("PutFunctionConcurrencyCommand");
    expect(cmds[0]!.input).toEqual({ FunctionName: "fn", ReservedConcurrentExecutions: 3 });
    expect(cmds[1]!.constructor.name).toBe("DeleteFunctionConcurrencyCommand");
    expect(cmds[1]!.input).toEqual({ FunctionName: "fn" });
    falla = true;
    await expect(c.poner(0)).rejects.toThrow(/^lambda: PutFunctionConcurrency fallo$/);
  });

  it("adaptador Dynamo: PutItem de CONTROL apagado y habilitado (sin motivo)", async () => {
    const items: Array<Record<string, unknown>> = [];
    const doc = {
      send: async (c: { input: { Item: Record<string, unknown> } }) => void items.push(c.input.Item),
    } as unknown as DocClientLike;
    const e = crearControlEscritorDynamo(doc, "t", () => Date.UTC(2026, 9, 21));
    await e.apagar("flood");
    await e.habilitar();
    expect(items[0]).toMatchObject({ pk: "CONTROL", habilitado: false, motivo: "flood" });
    expect(items[1]).toMatchObject({ pk: "CONTROL", habilitado: true });
    expect(items[1]).not.toHaveProperty("motivo");
  });
});
