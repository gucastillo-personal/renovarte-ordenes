/**
 * Idempotencia por canal (B11; RFC rev. 4 5.2, 5.3, 5.4; AC-24, ADR-0020).
 *
 * Item `IDEM#<key>` con un estado por canal (`mail_estado`,
 * `discord_estado`: enviando | entregado | fallido | incierto). Este modulo
 * decide, sin I/O propio, que hacer con una `idempotency_key`:
 *
 *  - key nueva -> reserva condicional (`attribute_not_exists(pk)`) con los
 *    dos canales en `enviando`; devuelve `nueva` con ambos canales a enviar;
 *  - key existente -> `huella` distinta: `invalida`; algun canal
 *    `entregado`: `aceptada` (mismo numero, sin enviar); si no, claim
 *    condicional de cada canal `fallido`; sin nada que reclamar:
 *    `en_proceso` (algun `enviando` con < 30 s) o `estado_incierto`.
 *
 * El item NO guarda datos personales: se arma campo por campo (sin copiar
 * la orden) y solo lleva la huella. Nunca se borra (sin `DeleteItem`): el
 * store ni siquiera lo expone. `expira_en` es Number en epoch-segundos
 * (+90 dias). Store y reloj entran por parametro; un error del store se
 * propaga y el handler lo traduce a `falla`/`interno`.
 */
import { huellasIguales } from "./payload-hmac.js";
import { esNumeroOrden } from "./order-number.js";

export const CANALES = ["mail", "discord"] as const;
export type Canal = (typeof CANALES)[number];
export type EstadoCanal = "enviando" | "entregado" | "fallido" | "incierto";

export const ENVIANDO_VENTANA_MS = 30_000;
export const IDEM_TTL_SEGUNDOS = 90 * 24 * 60 * 60;

export const claveIdem = (key: string): string => `IDEM#${key}`;

/** Item `IDEM#`. `_intento_en` en epoch-ms; `creado_en` ISO-8601 UTC. */
export interface ItemIdem {
  pk: string;
  mail_estado: EstadoCanal;
  discord_estado: EstadoCanal;
  mail_intento_en: number;
  discord_intento_en: number;
  payload_hmac: string;
  numero_orden: string;
  creado_en: string;
  /** Number, epoch-segundos. */
  expira_en: number;
  mail_message_id?: string;
  discord_message_id?: string;
  mail_codigo?: string;
  discord_codigo?: string;
}

export type ResultadoCanal =
  | { estado: "entregado"; message_id: string }
  | { estado: "fallido" | "incierto"; codigo: string };

/**
 * Store minimo (el handler lo implementa sobre DynamoDB). Sin borrado.
 * Cualquier error distinto de la condicion fallida debe rechazar.
 */
export interface IdempotenciaStore {
  /** `PutItem` con `attribute_not_exists(pk)`; `false` si ya existia. */
  reservar(item: ItemIdem): Promise<boolean>;
  leer(pk: string): Promise<ItemIdem | undefined>;
  /**
   * `UpdateItem SET <canal>_estado = "enviando", <canal>_intento_en = :ahora
   * IF <canal>_estado = "fallido"`. `false` si la condicion no se cumple.
   */
  reclamar(pk: string, canal: Canal, ahora: number): Promise<boolean>;
  /**
   * `UpdateItem` de `<canal>_estado` + `_message_id`/`_codigo`, con la
   * condicion `<canal>_estado = "enviando" AND <canal>_intento_en =
   * :intentoEn`. `false` si la condicion no se cumple.
   */
  persistirCanal(
    pk: string,
    canal: Canal,
    intentoEn: number,
    resultado: ResultadoCanal,
  ): Promise<boolean>;
}

export interface IdempotenciaDeps {
  store: IdempotenciaStore;
  /** Reloj en epoch-ms. */
  ahora: () => number;
}

export interface EntradaIdempotencia {
  idempotency_key: string;
  /** Huella de `calcularPayloadHmac`. */
  payload_hmac: string;
  /** Se invoca solo si la key es nueva; `null` = no se pudo reservar. */
  asignarNumero: () => Promise<string | null>;
}

export type ResultadoIdempotencia =
  // Key nueva: enviar por los dos canales con estos `intento_en`.
  | { tipo: "nueva"; numero_orden: string; canales: Canal[]; intento_en: Record<Canal, number> }
  // Key existente, canal(es) `fallido` reclamados: enviar solo esos.
  | { tipo: "reintento"; numero_orden: string; canales: Canal[]; intento_en: Partial<Record<Canal, number>> }
  // Algun canal `entregado`: 200 aceptada, sin enviar.
  | { tipo: "aceptada"; numero_orden: string; recibida_en: string }
  // Misma key con otra carga: 422 invalida con `errores: []`.
  | { tipo: "invalida" }
  | { tipo: "falla"; codigo: "en_proceso" | "estado_incierto" | "interno" };

const FALLA_INTERNO: ResultadoIdempotencia = { tipo: "falla", codigo: "interno" };

export async function resolverIdempotencia(
  deps: IdempotenciaDeps,
  entrada: EntradaIdempotencia,
): Promise<ResultadoIdempotencia> {
  const pk = claveIdem(entrada.idempotency_key);
  let existente = await deps.store.leer(pk);

  if (existente === undefined) {
    const numero = await entrada.asignarNumero();
    if (numero === null || !esNumeroOrden(numero)) return FALLA_INTERNO;
    const ahora = deps.ahora();
    // Campo por campo: nunca se copia la orden ni se acepta otro dato.
    const item: ItemIdem = {
      pk,
      mail_estado: "enviando",
      discord_estado: "enviando",
      mail_intento_en: ahora,
      discord_intento_en: ahora,
      payload_hmac: entrada.payload_hmac,
      numero_orden: numero,
      creado_en: new Date(ahora).toISOString(),
      expira_en: Math.floor(ahora / 1000) + IDEM_TTL_SEGUNDOS,
    };
    if (await deps.store.reservar(item)) {
      return {
        tipo: "nueva",
        numero_orden: numero,
        canales: [...CANALES],
        intento_en: { mail: ahora, discord: ahora },
      };
    }
    // Otra request reservo primero: se resuelve como key existente.
    existente = await deps.store.leer(pk);
    if (existente === undefined) return FALLA_INTERNO;
  }

  return resolverExistente(deps, pk, existente, entrada.payload_hmac);
}

async function resolverExistente(
  deps: IdempotenciaDeps,
  pk: string,
  item: ItemIdem,
  huella: string,
): Promise<ResultadoIdempotencia> {
  if (!huellasIguales(item.payload_hmac, huella)) return { tipo: "invalida" };
  if (!esNumeroOrden(item.numero_orden)) return FALLA_INTERNO;

  if (CANALES.some((c) => item[`${c}_estado`] === "entregado")) {
    return { tipo: "aceptada", numero_orden: item.numero_orden, recibida_en: item.creado_en };
  }

  const ahora = deps.ahora();
  const candidatos = CANALES.filter((c) => item[`${c}_estado`] === "fallido");
  const reclamados: Canal[] = [];
  const intento_en: Partial<Record<Canal, number>> = {};
  for (const canal of candidatos) {
    if (await deps.store.reclamar(pk, canal, ahora)) {
      reclamados.push(canal);
      intento_en[canal] = ahora;
    }
  }
  if (reclamados.length > 0) {
    return { tipo: "reintento", numero_orden: item.numero_orden, canales: reclamados, intento_en };
  }

  // Perdio el claim contra otra request concurrente: esa la tiene en curso.
  if (candidatos.length > 0) return { tipo: "falla", codigo: "en_proceso" };

  const enCurso = CANALES.some(
    (c) => item[`${c}_estado`] === "enviando" && ahora - item[`${c}_intento_en`] < ENVIANDO_VENTANA_MS,
  );
  return { tipo: "falla", codigo: enCurso ? "en_proceso" : "estado_incierto" };
}

/**
 * Persiste el resultado de un canal apenas termina su envio, condicionado a
 * que siga `enviando` con el mismo `intento_en`. `false` = otra request
 * ya lo cambio (no se pisa).
 */
export function registrarCanal(
  deps: IdempotenciaDeps,
  idempotencyKey: string,
  canal: Canal,
  intentoEn: number,
  resultado: ResultadoCanal,
): Promise<boolean> {
  return deps.store.persistirCanal(claveIdem(idempotencyKey), canal, intentoEn, resultado);
}
