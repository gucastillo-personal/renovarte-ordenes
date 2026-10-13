/**
 * `form_token` anti-bot (B7; RFC rev. 4 3.1 y 6.2; AC-19; Q-F4; ADR-0019).
 *
 * Stateless: `v1.<emitido_en_ms>.<firma>`, con firma =
 * base64url(HMAC-SHA256(secreto, "form_token.v1." + "<emitido_en_ms>")).
 * El prefijo de dominio evita que la firma sirva para otro uso del mismo
 * secreto (p.ej. el HMAC de la IP). Valido con antiguedad entre 3 s y 2 h,
 * ambos extremos inclusive, medida con el reloj del servidor.
 *
 * Todo lo que no sea un token vigente (vencido, de < 3 s, del futuro, con
 * firma ajena o malformado) devuelve el MISMO `token_vencido`: no se da
 * pista de la ventana minima (Q-F4). La firma se compara en tiempo
 * constante.
 *
 * Funciones puras: el secreto (leido de SSM por el handler, ADR-0019) y el
 * reloj entran por parametro. Nunca se loguea el token ni el secreto.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_EDAD_MIN_MS = 3 * 1000;
export const TOKEN_EDAD_MAX_MS = 2 * 60 * 60 * 1000;

const DOMINIO = "form_token.v1.";
const FORMATO = /^v1\.([0-9]{1,15})\.([A-Za-z0-9_-]{43})$/;

export type Secreto = string | Uint8Array;

export type ResultadoToken =
  | { ok: true; emitido_en: number }
  | { ok: false; codigo: "token_vencido" };

function firmar(secreto: Secreto, emitidoEn: string): Buffer {
  if (secreto.length === 0) throw new Error("secreto vacio");
  return createHmac("sha256", secreto).update(DOMINIO + emitidoEn).digest();
}

/** Emite un token con `ahoraMs` (ms epoch, reloj del servidor). */
export function emitirToken(secreto: Secreto, ahoraMs: number): string {
  if (!Number.isSafeInteger(ahoraMs) || ahoraMs < 0) throw new Error("reloj invalido");
  const t = String(ahoraMs);
  return `v1.${t}.${firmar(secreto, t).toString("base64url")}`;
}

export function verificarToken(token: unknown, secreto: Secreto, ahoraMs: number): ResultadoToken {
  const vencido: ResultadoToken = { ok: false, codigo: "token_vencido" };
  if (typeof token !== "string") return vencido;
  const m = FORMATO.exec(token);
  if (m === null) return vencido;
  const t = m[1] as string;
  const recibida = Buffer.from(m[2] as string, "base64url");
  const esperada = firmar(secreto, t);
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return vencido;
  const emitidoEn = Number(t);
  const edad = ahoraMs - emitidoEn;
  if (!Number.isSafeInteger(emitidoEn) || edad < TOKEN_EDAD_MIN_MS || edad > TOKEN_EDAD_MAX_MS) {
    return vencido;
  }
  return { ok: true, emitido_en: emitidoEn };
}
