/**
 * Numero de orden (B8; RFC rev. 4 9; AC-10, AC-13).
 *
 * Formato `RA-` + 5 digitos aleatorios (`RA-48271`), generados con
 * `crypto.randomInt`. Unicidad por reserva condicional: `PutItem` de
 * `pk = NUM#RA-xxxxx` con `attribute_not_exists(pk)`, hasta 5 intentos. Los
 * items `NUM#` no llevan TTL (para no reusar numeros) ni datos personales.
 *
 * Modulo puro: el store (que el handler implementa sobre DynamoDB) y el
 * generador entran por parametro. El numero se asigna una vez por
 * `idempotency_key`; reusarlo en los reintentos es responsabilidad del
 * llamador (lo lee del registro `IDEM#`).
 *
 * Un error del store (distinto de "ya existe") no es colision: se propaga
 * y el handler lo traduce a `falla`/`interno`. Nunca se loguea contacto.
 */
import { randomInt } from "node:crypto";

export const NUMERO_PREFIJO = "RA-";
export const NUMERO_DIGITOS = 5;
export const NUMERO_MAX_INTENTOS = 5;

const FORMATO = /^RA-[0-9]{5}$/;

/** Store minimo: reserva condicional de una clave `pk`. */
export interface NumeroStore {
  /**
   * `PutItem` con `attribute_not_exists(pk)`. Resuelve `true` si reservo y
   * `false` si la clave ya existia (ConditionalCheckFailed). Cualquier otro
   * error debe rechazar la promesa.
   */
  reservar(pk: string): Promise<boolean>;
}

export interface OrderNumberDeps {
  store: NumeroStore;
  /** Generador de numeros de orden; por defecto `generarNumero`. */
  generar?: () => string;
}

export type ResultadoNumero =
  | { ok: true; numero: string; intentos: number }
  | { ok: false; resultado: "falla"; codigo: "interno" };

/** `RA-` + 5 digitos (con ceros a la izquierda) uniformes. */
export function generarNumero(): string {
  return NUMERO_PREFIJO + String(randomInt(0, 10 ** NUMERO_DIGITOS)).padStart(NUMERO_DIGITOS, "0");
}

export function esNumeroOrden(valor: unknown): valor is string {
  return typeof valor === "string" && FORMATO.test(valor);
}

export function claveNumero(numero: string): string {
  return `NUM#${numero}`;
}

export async function reservarNumero(deps: OrderNumberDeps): Promise<ResultadoNumero> {
  const generar = deps.generar ?? generarNumero;
  for (let intento = 1; intento <= NUMERO_MAX_INTENTOS; intento++) {
    const numero = generar();
    if (!esNumeroOrden(numero)) throw new Error("numero de orden invalido");
    if (await deps.store.reservar(claveNumero(numero))) return { ok: true, numero, intentos: intento };
  }
  return { ok: false, resultado: "falla", codigo: "interno" };
}
