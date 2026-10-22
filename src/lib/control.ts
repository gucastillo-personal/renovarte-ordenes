/**
 * Flag de control `CONTROL` (B14; RFC rev. 4 6.5 paso 1, 8.2, 8.4; AC-22).
 *
 * Item `CONTROL = { habilitado, motivo }`. Se lee con cache de 30 s (sin
 * escribir en DynamoDB en el camino caliente) y el motivo se mapea a la
 * respuesta de `GET /v1/estado` y de `POST /v1/ordenes` (tabla de 8.4).
 * Sin item = habilitado. Un item apagado con motivo desconocido se trata
 * como `desconocido` (fail-safe: apagado). Store y reloj se inyectan; un
 * error del store se propaga (el handler lo traduce a `falla`/`interno`).
 * Modulo sin datos personales.
 */
import type { CrearOrdenResponse, EstadoResponse } from "../wire.js";

export const CONTROL_PK = "CONTROL";
export const CONTROL_CACHE_MS = 30_000;

export const MOTIVOS = ["tope_alcanzado", "presupuesto", "flood", "desconocido", "manual"] as const;
export type Motivo = (typeof MOTIVOS)[number];

export interface ItemControl {
  pk: typeof CONTROL_PK;
  habilitado: boolean;
  motivo?: string;
}

export interface ControlStore {
  /** `GetItem CONTROL`; `undefined` si no existe. */
  leer(): Promise<ItemControl | undefined>;
  /** `PutItem CONTROL = { habilitado: false, motivo }`. */
  apagar(motivo: Motivo): Promise<void>;
}

export interface ControlDeps {
  store: ControlStore;
  /** Reloj en epoch-ms. */
  ahora: () => number;
}

export type EstadoControl = { habilitado: true } | { habilitado: false; motivo: Motivo };

const MOTIVOS_SET: ReadonlySet<string> = new Set(MOTIVOS);

export function aEstadoControl(item: ItemControl | undefined): EstadoControl {
  if (item === undefined || item.habilitado === true) return { habilitado: true };
  const motivo: Motivo =
    typeof item.motivo === "string" && MOTIVOS_SET.has(item.motivo) ? (item.motivo as Motivo) : "desconocido";
  return { habilitado: false, motivo };
}

/** Lector con cache de 30 s; una instancia por contenedor Lambda. */
export interface LectorControl {
  leer(): Promise<EstadoControl>;
  /** Apaga (escribe `CONTROL`) y refresca la cache local. */
  apagar(motivo: Motivo): Promise<void>;
}

export function crearLectorControl(deps: ControlDeps): LectorControl {
  let cache: { estado: EstadoControl; hasta: number } | undefined;
  return {
    async leer() {
      const t = deps.ahora();
      if (cache !== undefined && t < cache.hasta) return cache.estado;
      const estado = aEstadoControl(await deps.store.leer());
      cache = { estado, hasta: t + CONTROL_CACHE_MS };
      return estado;
    },
    async apagar(motivo) {
      await deps.store.apagar(motivo);
      cache = { estado: { habilitado: false, motivo }, hasta: deps.ahora() + CONTROL_CACHE_MS };
    },
  };
}

const esTope = (m: Motivo): boolean => m === "tope_alcanzado" || m === "presupuesto";

/** `GET /v1/estado` con el flag apagado (8.4). Habilitado: no aplica (null). */
export function respuestaEstadoApagado(
  estado: EstadoControl,
): Exclude<EstadoResponse, { resultado: "disponible" }> | null {
  if (estado.habilitado) return null;
  return esTope(estado.motivo) ? { v: 1, resultado: "tope_alcanzado" } : { v: 1, resultado: "no_disponible" };
}

/** `POST /v1/ordenes` con el flag apagado: siempre 503 (8.4). */
export function respuestaOrdenApagado(
  estado: EstadoControl,
): { status: 503; body: CrearOrdenResponse } | null {
  if (estado.habilitado) return null;
  return esTope(estado.motivo)
    ? { status: 503, body: { v: 1, resultado: "tope_alcanzado" } }
    : { status: 503, body: { v: 1, resultado: "falla", codigo: "mantenimiento" } };
}
