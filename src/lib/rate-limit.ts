/**
 * Rate limit por IP y cupo global de ordenes (B13; RFC rev. 4 6.3, 6.5;
 * AC-19, ADR-0020).
 *
 * La IP jamas se guarda ni se loguea en claro: solo `HMAC-SHA256(secreto,
 * "ip-v1" || ip)` en la clave de los contadores `RL#`, con TTL de 24 h.
 * Contadores por ventana UTC (hora / dia):
 *  - POST por IP: `ADD` condicional (20/h); si se excede -> 429.
 *  - Aceptadas por IP (3/h, 10/dia): se leen en el paso 2 y se incrementan
 *    solo cuando una orden queda `aceptada` (`registrarAceptada`).
 *  - Cupo global `CUPO#dia` / `CUPO#mes` (50/dia, 1000/mes): una sola vez
 *    por key nueva, atomico entre ambos (un transact en el store), SIN
 *    devolucion: la key no se libera ante una falla. Excedido -> 503 y log
 *    de alerta.
 * Umbrales por env var. Store, reloj y logger se inyectan; un error del
 * store se propaga (el handler lo traduce a `falla`/`interno`).
 */
import { createHmac } from "node:crypto";
import type { CrearOrdenResponse } from "../wire.js";
import type { Logger } from "./log.js";

export const IP_DOMINIO = "ip-v1";
export const RL_TTL_SEGUNDOS = 24 * 60 * 60;
export const CUPO_DIA_TTL_SEGUNDOS = 2 * 24 * 60 * 60;
export const CUPO_MES_TTL_SEGUNDOS = 40 * 24 * 60 * 60;

export interface UmbralesRateLimit {
  postPorHoraIp: number;
  aceptadasPorHoraIp: number;
  aceptadasPorDiaIp: number;
  ordenesPorDia: number;
  ordenesPorMes: number;
}

export const UMBRALES_DEFAULT: UmbralesRateLimit = {
  postPorHoraIp: 20,
  aceptadasPorHoraIp: 3,
  aceptadasPorDiaIp: 10,
  ordenesPorDia: 50,
  ordenesPorMes: 1000,
};

const entero = (v: string | undefined, def: number): number => {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 1_000_000 ? n : def;
};

/** Env vars: RL_POST_POR_HORA_IP, RL_ACEPTADAS_POR_HORA_IP, RL_ACEPTADAS_POR_DIA_IP, CUPO_ORDENES_DIA, CUPO_ORDENES_MES. */
export function umbralesDesdeEnv(env: Readonly<Record<string, string | undefined>>): UmbralesRateLimit {
  const d = UMBRALES_DEFAULT;
  return {
    postPorHoraIp: entero(env["RL_POST_POR_HORA_IP"], d.postPorHoraIp),
    aceptadasPorHoraIp: entero(env["RL_ACEPTADAS_POR_HORA_IP"], d.aceptadasPorHoraIp),
    aceptadasPorDiaIp: entero(env["RL_ACEPTADAS_POR_DIA_IP"], d.aceptadasPorDiaIp),
    ordenesPorDia: entero(env["CUPO_ORDENES_DIA"], d.ordenesPorDia),
    ordenesPorMes: entero(env["CUPO_ORDENES_MES"], d.ordenesPorMes),
  };
}

/** `HMAC-SHA256(secreto, "ip-v1" || ip)` en hex. */
export function hmacIp(secreto: string | Buffer, ip: string): string {
  if (secreto.length === 0) throw new Error("secreto_hmac vacio");
  if (typeof ip !== "string" || ip === "") throw new Error("ip vacia");
  return createHmac("sha256", secreto).update(IP_DOMINIO, "utf8").update(ip, "utf8").digest("hex");
}

// Ventanas UTC: hora `YYYY-MM-DDTHH`, dia `YYYY-MM-DD`, mes `YYYY-MM`.
const iso = (ms: number): string => new Date(ms).toISOString();
export const ventanaHora = (ms: number): string => iso(ms).slice(0, 13);
export const ventanaDia = (ms: number): string => iso(ms).slice(0, 10);
export const ventanaMes = (ms: number): string => iso(ms).slice(0, 7);

export const clavePost = (h: string, ms: number): string => `RL#post#${h}#h#${ventanaHora(ms)}`;
export const claveAceptadaHora = (h: string, ms: number): string => `RL#acep#${h}#h#${ventanaHora(ms)}`;
export const claveAceptadaDia = (h: string, ms: number): string => `RL#acep#${h}#d#${ventanaDia(ms)}`;
export const claveCupoDia = (ms: number): string => `CUPO#dia#${ventanaDia(ms)}`;
export const claveCupoMes = (ms: number): string => `CUPO#mes#${ventanaMes(ms)}`;

export interface Contador {
  pk: string;
  /** Tope inclusivo: el contador no pasa de este valor. */
  limite: number;
  /** Number, epoch-segundos. */
  expiraEn: number;
}

export interface RateLimitStore {
  /**
   * `UpdateItem ADD n :1 SET expira_en = :exp` con condicion
   * `attribute_not_exists(n) OR n < :limite`. `false` si ya estaba en el limite.
   */
  incrementarCondicional(c: Contador): Promise<boolean>;
  /** `UpdateItem ADD n :1 SET expira_en = :exp`, sin condicion. */
  incrementar(pk: string, expiraEn: number): Promise<void>;
  /** `GetItem` (consistente); 0 si no existe. */
  leer(pk: string): Promise<number>;
  /**
   * `TransactWriteItems` con los dos contadores condicionales: o suma
   * ambos o ninguno. Devuelve cual limite fallo.
   */
  consumirCupo(dia: Contador, mes: Contador): Promise<"ok" | "dia" | "mes">;
}

export interface RateLimitDeps {
  store: RateLimitStore;
  umbrales: UmbralesRateLimit;
  /** Reloj en epoch-ms. */
  ahora: () => number;
  logger: Logger;
}

export type RespuestaLimite = { status: 429 | 503; body: Extract<CrearOrdenResponse, { resultado: "falla" }> };

const LIMITE: RespuestaLimite["body"] = { v: 1, resultado: "falla", codigo: "limite_frecuencia" };

export type ResultadoRateLimit = { ok: true } | ({ ok: false } & RespuestaLimite);

const expira = (ms: number, ttl: number): number => Math.floor(ms / 1000) + ttl;

/**
 * Paso 2 de 6.5. Cuenta el POST (1 `UpdateItem`) y verifica las aceptadas
 * por IP (2 lecturas). `ipHmac` viene de `hmacIp`; la IP en claro no entra.
 */
export async function verificarRateLimitIp(deps: RateLimitDeps, ipHmac: string): Promise<ResultadoRateLimit> {
  const ahora = deps.ahora();
  const u = deps.umbrales;
  const pasoPost = await deps.store.incrementarCondicional({
    pk: clavePost(ipHmac, ahora),
    limite: u.postPorHoraIp,
    expiraEn: expira(ahora, RL_TTL_SEGUNDOS),
  });
  if (!pasoPost) return limiteIp(deps, "post_hora");
  const [hora, dia] = await Promise.all([
    deps.store.leer(claveAceptadaHora(ipHmac, ahora)),
    deps.store.leer(claveAceptadaDia(ipHmac, ahora)),
  ]);
  if (hora >= u.aceptadasPorHoraIp) return limiteIp(deps, "aceptadas_hora");
  if (dia >= u.aceptadasPorDiaIp) return limiteIp(deps, "aceptadas_dia");
  return { ok: true };
}


function limiteIp(deps: RateLimitDeps, codigo: string): ResultadoRateLimit {
  // Sin IP ni su HMAC en el log: solo cual limite se excedio.
  deps.logger.log("warn", { evento: "limite_ip", resultado: "limite_frecuencia", codigo, http_status: 429 });
  return { ok: false, status: 429, body: LIMITE };
}

/** Paso 7 de 5.3: una orden quedo `aceptada` por primera vez. */
export async function registrarAceptada(deps: RateLimitDeps, ipHmac: string): Promise<void> {
  const ahora = deps.ahora();
  await Promise.all([
    deps.store.incrementar(claveAceptadaHora(ipHmac, ahora), expira(ahora, RL_TTL_SEGUNDOS)),
    deps.store.incrementar(claveAceptadaDia(ipHmac, ahora), expira(ahora, RL_TTL_SEGUNDOS)),
  ]);
}

/**
 * Paso 6 de 6.5: cupo global de ordenes, consumido una vez por key nueva.
 * No hay devolucion. Excedido -> 503 `falla`/`limite_frecuencia` + alerta.
 */
export async function consumirCupoGlobal(deps: RateLimitDeps): Promise<ResultadoRateLimit> {
  const ahora = deps.ahora();
  const r = await deps.store.consumirCupo(
    { pk: claveCupoDia(ahora), limite: deps.umbrales.ordenesPorDia, expiraEn: expira(ahora, CUPO_DIA_TTL_SEGUNDOS) },
    { pk: claveCupoMes(ahora), limite: deps.umbrales.ordenesPorMes, expiraEn: expira(ahora, CUPO_MES_TTL_SEGUNDOS) },
  );
  if (r === "ok") return { ok: true };
  deps.logger.log("error", { evento: "cupo_global_agotado", resultado: "limite_frecuencia", codigo: r, http_status: 503 });
  return { ok: false, status: 503, body: LIMITE };
}
