/**
 * Ledger de gasto estimado `LEDGER#YYYY-MM` (B14; RFC rev. 4 8.2; AC-22).
 *
 * `ADD` atomico de costos unitarios conservadores (inflados x2,
 * configurables): por request procesada (Lambda + DynamoDB, incluido el
 * `UpdateItem` extra de Discord) y por mail enviado (SES). Discord cuesta 0
 * y no es una variable. Si el valor devuelto es
 * `>= BUDGET_CAP_USD x BUDGET_STOP_RATIO`, se apaga `CONTROL` con motivo
 * `tope_alcanzado` (salvo que ya este apagado: no se pisa otro motivo ni se
 * escribe de mas). Mes en UTC. Sin datos personales. Store y reloj se
 * inyectan.
 */
import type { LectorControl } from "./control.js";

export const LEDGER_TTL_SEGUNDOS = 90 * 24 * 60 * 60;

export const COSTO_DISCORD_USD = 0;

export interface ConfigLedger {
  budgetCapUsd: number;
  budgetStopRatio: number;
  /** USD por request procesada. */
  costoRequestUsd: number;
  /** USD por mail enviado. */
  costoMailUsd: number;
}

export const CONFIG_LEDGER_DEFAULT: ConfigLedger = {
  budgetCapUsd: 20,
  budgetStopRatio: 0.9,
  // Referencia: Lambda+DynamoDB ~ USD 0,00001 por request; SES USD 0,0001 por mail; x2.
  costoRequestUsd: 0.00002,
  costoMailUsd: 0.0002,
};

const num = (v: string | undefined, def: number, min: number, max: number): number => {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
};

/** Lee `BUDGET_CAP_USD`, `BUDGET_STOP_RATIO`, `COSTO_REQUEST_USD`, `COSTO_MAIL_USD`. */
export function configLedgerDesdeEnv(env: Readonly<Record<string, string | undefined>>): ConfigLedger {
  const d = CONFIG_LEDGER_DEFAULT;
  return {
    budgetCapUsd: num(env["BUDGET_CAP_USD"], d.budgetCapUsd, 0.01, 1_000_000),
    budgetStopRatio: num(env["BUDGET_STOP_RATIO"], d.budgetStopRatio, 0.01, 1),
    costoRequestUsd: num(env["COSTO_REQUEST_USD"], d.costoRequestUsd, 0, 1),
    costoMailUsd: num(env["COSTO_MAIL_USD"], d.costoMailUsd, 0, 1),
  };
}

export const claveLedger = (ahoraMs: number): string => `LEDGER#${new Date(ahoraMs).toISOString().slice(0, 7)}`;

export interface LedgerStore {
  /**
   * `UpdateItem ADD gasto_estimado_usd :usd SET expira_en = :exp`
   * (ReturnValues UPDATED_NEW). Devuelve el acumulado del mes.
   */
  sumar(pk: string, usd: number, expiraEn: number): Promise<number>;
}

export interface LedgerDeps {
  store: LedgerStore;
  control: LectorControl;
  config: ConfigLedger;
  /** Reloj en epoch-ms. */
  ahora: () => number;
}

export interface Consumo {
  /** Requests procesadas (normalmente 1). */
  requests: number;
  /** Mails enviados. */
  mails: number;
}

export interface ResultadoLedger {
  gasto_estimado_usd: number;
  tope_alcanzado: boolean;
}

export const umbralCorte = (c: ConfigLedger): number => c.budgetCapUsd * c.budgetStopRatio;

export function costoDe(c: ConfigLedger, consumo: Consumo): number {
  return consumo.requests * c.costoRequestUsd + consumo.mails * c.costoMailUsd + 0 * COSTO_DISCORD_USD;
}

export async function registrarGasto(deps: LedgerDeps, consumo: Consumo): Promise<ResultadoLedger> {
  const ahora = deps.ahora();
  const usd = costoDe(deps.config, consumo);
  const gasto = await deps.store.sumar(claveLedger(ahora), usd, Math.floor(ahora / 1000) + LEDGER_TTL_SEGUNDOS);
  const alcanzado = gasto >= umbralCorte(deps.config);
  if (alcanzado && (await deps.control.leer()).habilitado) {
    await deps.control.apagar("tope_alcanzado");
  }
  return { gasto_estimado_usd: gasto, tope_alcanzado: alcanzado };
}
