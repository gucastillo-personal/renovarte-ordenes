/**
 * Huella de idempotencia `payload_hmac` (B11; RFC rev. 4 5.4.1; ADR-0020).
 *
 * `k = HMAC-SHA256(secreto, "payload-v1" || idempotency_key)` y
 * `payload_hmac = HMAC-SHA256(k, canonico)`, donde `canonico` es el
 * `JSON.stringify` de un array de orden fijo:
 * `[v, lineas ordenadas por producto_id [producto_id, cantidad,
 * precio_visto], total_visto, nombre_normalizado, telefono_recortado]`.
 *
 * El resultado son los 256 bits completos (64 hex) y se compara en tiempo
 * constante. Lo unico que se persiste es la huella: ni el nombre, ni el
 * telefono, ni un prefijo o largo de ellos. Modulo puro; el secreto
 * (`secreto_hmac` de SSM) entra por parametro y jamas se loguea.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CrearOrdenRequest } from "../wire.js";

export const PAYLOAD_DOMINIO = "payload-v1";
export const PAYLOAD_HMAC_HEX = 64;

/** Subconjunto de la orden validada que entra en la huella. */
export type PayloadParaHuella = Pick<
  CrearOrdenRequest,
  "v" | "idempotency_key" | "lineas" | "total_visto" | "contacto"
>;

const aBuffer = (s: string | Buffer): Buffer => (typeof s === "string" ? Buffer.from(s, "utf8") : s);

/** Clave derivada por orden (separacion de dominio + `idempotency_key`). */
export function derivarClave(secreto: string | Buffer, idempotencyKey: string): Buffer {
  if (aBuffer(secreto).length === 0) throw new Error("secreto_hmac vacio");
  if (typeof idempotencyKey !== "string" || idempotencyKey === "") {
    throw new Error("idempotency_key vacia");
  }
  return createHmac("sha256", secreto).update(PAYLOAD_DOMINIO, "utf8").update(idempotencyKey, "utf8").digest();
}

const porCodigo = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Serializacion canonica. El nombre se vuelve a normalizar (NFC, recorte,
 * espacios colapsados; idempotente sobre la salida de `validarNombre`) y el
 * telefono se recorta, tal cual lo escribio el visitante.
 */
export function payloadCanonico(p: PayloadParaHuella): string {
  const lineas = [...p.lineas]
    .sort((a, b) => porCodigo(a.producto_id, b.producto_id))
    .map((l) => [l.producto_id, l.cantidad, l.precio_visto]);
  const nombre = p.contacto.nombre.normalize("NFC").trim().replace(/\s+/gu, " ");
  const telefono = p.contacto.telefono.trim();
  return JSON.stringify([p.v, lineas, p.total_visto, nombre, telefono]);
}

/** HMAC-SHA256 completo (256 bits) en hex minusculas. */
export function calcularPayloadHmac(secreto: string | Buffer, p: PayloadParaHuella): string {
  const k = derivarClave(secreto, p.idempotency_key);
  return createHmac("sha256", k).update(payloadCanonico(p), "utf8").digest("hex");
}

/** Comparacion en tiempo constante; largos distintos o no-hex -> `false`. */
export function huellasIguales(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== PAYLOAD_HMAC_HEX || b.length !== PAYLOAD_HMAC_HEX) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== PAYLOAD_HMAC_HEX / 2 || bb.length !== PAYLOAD_HMAC_HEX / 2) return false;
  return timingSafeEqual(ba, bb);
}
