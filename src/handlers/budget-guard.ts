/**
 * Handler `budget-guard` (B16; RFC rev. 4 8.3-8.4; AC-22; ADR-0005).
 *
 * Kill-switch de la capa 3 del corte de gasto. Un solo topic SNS al que
 * publican dos fuentes (AWS Budgets al 100 % y la alarma de flood de
 * CloudWatch) mas el evento manual/programado `{ mode: "reset" }`.
 *
 * Disparador valido (idempotente): `CONTROL = { habilitado: false, motivo }`
 * y `PutFunctionConcurrency(orders-http, 0)`. Las dos acciones se intentan
 * aunque una falle (fail-safe: el error barato es apagar); si alguna falla
 * se relanza para que SNS reintente.
 *
 * `reset`: primero `CONTROL` habilitado (si falla, NO se toca la
 * concurrency: el servicio sigue cerrado) y despues
 * `PutFunctionConcurrency(n)` o `DeleteFunctionConcurrency` si
 * `ORDERS_HTTP_RESERVED_CONCURRENCY` esta vacia.
 *
 * No toca el ledger ni las ordenes (IAM con `LeadingKeys = ["CONTROL"]`).
 * Nunca loguea el cuerpo del mensaje SNS (trae ID de cuenta y ARNs): solo
 * el motivo y la accion. Puertos inyectables; modulo sin datos personales.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { crearControlEscritorDynamo } from "../adapters/dynamo.js";
import { crearConcurrenciaLambda } from "../adapters/lambda.js";
import type { Motivo } from "../lib/control.js";
import { crearLogger, type Logger } from "../lib/log.js";

/** Escritura de `CONTROL` (a diferencia de `ControlStore`, tambien habilita). */
export interface ControlEscritor {
  apagar(motivo: Motivo): Promise<void>;
  habilitar(): Promise<void>;
}

/** Concurrencia reservada de `orders-http`. */
export interface ConcurrenciaOrdenes {
  poner(n: number): Promise<void>;
  quitar(): Promise<void>;
}

export interface ConfigBudgetGuard {
  budgetName: string;
  floodAlarmName: string;
  /** `undefined` = cuenta sin reserva posible (I-D4 caso b). */
  reservedConcurrency: number | undefined;
}

export interface DepsBudgetGuard {
  control: ControlEscritor;
  concurrencia: ConcurrenciaOrdenes;
  config: ConfigBudgetGuard;
  logger: Logger;
}

export type ResultadoBudgetGuard =
  | { accion: "apagado"; motivo: Motivo }
  | { accion: "ignorado" }
  | { accion: "reset" };

export interface EventoBudgetGuard {
  mode?: unknown;
  Records?: ReadonlyArray<{ Sns?: { Message?: unknown } }>;
}

type Clasificacion = { tipo: "apagar"; motivo: Motivo } | { tipo: "ignorar" };

/** Clasifica un `Message` de SNS (RFC 8.4). */
export function clasificarMensaje(mensaje: unknown, config: ConfigBudgetGuard): Clasificacion {
  const desconocido: Clasificacion = { tipo: "apagar", motivo: "desconocido" };
  if (typeof mensaje !== "string") return desconocido;

  let json: unknown;
  try {
    json = JSON.parse(mensaje);
  } catch {
    json = undefined;
  }
  if (typeof json === "object" && json !== null && !Array.isArray(json)) {
    const m = json as { AlarmName?: unknown; NewStateValue?: unknown };
    if (config.floodAlarmName !== "" && m.AlarmName === config.floodAlarmName) {
      if (m.NewStateValue === "ALARM") return { tipo: "apagar", motivo: "flood" };
      if (m.NewStateValue === "OK" || m.NewStateValue === "INSUFFICIENT_DATA") return { tipo: "ignorar" };
    }
    return desconocido;
  }
  if (config.budgetName !== "" && mensaje.includes(config.budgetName)) {
    return { tipo: "apagar", motivo: "presupuesto" };
  }
  return desconocido;
}

export function crearHandlerBudgetGuard(deps: DepsBudgetGuard) {
  const { control, concurrencia, config, logger } = deps;

  const apagar = async (motivo: Motivo): Promise<ResultadoBudgetGuard> => {
    const r = await Promise.allSettled([control.apagar(motivo), concurrencia.poner(0)]);
    const [c, k] = r;
    logger.log(c.status === "fulfilled" ? "info" : "error", {
      evento: "budget_guard_control",
      resultado: c.status === "fulfilled" ? "ok" : "error",
      codigo: motivo,
    });
    logger.log(k.status === "fulfilled" ? "info" : "error", {
      evento: "budget_guard_concurrencia",
      resultado: k.status === "fulfilled" ? "ok" : "error",
      codigo: "cero",
    });
    if (c.status === "rejected" || k.status === "rejected") throw new Error("budget-guard: apagado incompleto");
    return { accion: "apagado", motivo };
  };

  const reset = async (): Promise<ResultadoBudgetGuard> => {
    try {
      await control.habilitar();
    } catch {
      logger.log("error", { evento: "budget_guard_reset", resultado: "error", codigo: "control" });
      throw new Error("budget-guard: reset fallido en CONTROL");
    }
    try {
      if (config.reservedConcurrency === undefined) await concurrencia.quitar();
      else await concurrencia.poner(config.reservedConcurrency);
    } catch {
      logger.log("error", { evento: "budget_guard_reset", resultado: "error", codigo: "concurrencia" });
      throw new Error("budget-guard: reset fallido en la concurrencia");
    }
    logger.log("info", { evento: "budget_guard_reset", resultado: "ok" });
    return { accion: "reset" };
  };

  return async (evento: EventoBudgetGuard): Promise<ResultadoBudgetGuard> => {
    if (evento?.mode === "reset") return reset();

    const registros = Array.isArray(evento?.Records) ? evento.Records : [];
    // Evento sin registros SNS ni `reset`: formato desconocido -> fail-safe.
    const clases: Clasificacion[] =
      registros.length === 0
        ? [{ tipo: "apagar", motivo: "desconocido" }]
        : registros.map((r) => clasificarMensaje(r?.Sns?.Message, config));

    const disparo = clases.find((c) => c.tipo === "apagar");
    if (disparo === undefined || disparo.tipo !== "apagar") {
      logger.log("info", { evento: "budget_guard", resultado: "ignorado" });
      return { accion: "ignorado" };
    }
    if (disparo.motivo === "desconocido") {
      logger.log("warn", { evento: "budget_guard", resultado: "formato_desconocido" });
    }
    return apagar(disparo.motivo);
  };
}

// --- Entrada de la Lambda --------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

function requerida(env: Env, nombre: string): string {
  const v = env[nombre];
  if (v === undefined || v.trim() === "") throw new Error(`config ausente: ${nombre}`);
  return v;
}

/** `ORDERS_HTTP_RESERVED_CONCURRENCY`: vacia -> `undefined`; entero >= 0 -> n; otra cosa -> error. */
export function concurrenciaDesdeEnv(env: Env): number | undefined {
  const v = env["ORDERS_HTTP_RESERVED_CONCURRENCY"];
  if (v === undefined || v.trim() === "") return undefined;
  if (!/^\d+$/.test(v.trim())) throw new Error("config invalida: ORDERS_HTTP_RESERVED_CONCURRENCY");
  return Number(v.trim());
}

export function construirDepsBudgetGuard(env: Env): DepsBudgetGuard {
  const region = env["AWS_REGION"];
  const ahora = (): number => Date.now();
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(region !== undefined ? { region } : {}));
  return {
    control: crearControlEscritorDynamo(doc, requerida(env, "ORDERS_TABLE"), ahora),
    concurrencia: crearConcurrenciaLambda(
      new LambdaClient(region !== undefined ? { region } : {}),
      requerida(env, "ORDERS_HTTP_FUNCTION_NAME"),
    ),
    config: {
      budgetName: requerida(env, "BUDGET_NAME"),
      floodAlarmName: requerida(env, "FLOOD_ALARM_NAME"),
      reservedConcurrency: concurrenciaDesdeEnv(env),
    },
    logger: crearLogger((linea) => console.log(linea), ahora),
  };
}

let instancia: ReturnType<typeof crearHandlerBudgetGuard> | undefined;

/** Lambda handler. Init perezosa para que importar el modulo no requiera env. */
export async function handler(evento: EventoBudgetGuard): Promise<ResultadoBudgetGuard> {
  instancia ??= crearHandlerBudgetGuard(construirDepsBudgetGuard(process.env));
  return instancia(evento);
}
