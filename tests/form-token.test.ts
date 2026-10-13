import { describe, expect, it } from "vitest";
import {
  TOKEN_EDAD_MAX_MS,
  TOKEN_EDAD_MIN_MS,
  emitirToken,
  verificarToken,
} from "../src/lib/form-token.js";

// Secretos ficticios de prueba.
const S = "secreto-ficticio-de-prueba";
const OTRO = "otro-secreto-ficticio";
const T0 = 1_700_000_000_000;
const VENCIDO = { ok: false, codigo: "token_vencido" };

describe("form-token (AC-19, Q-F4)", () => {
  it("round trip dentro de la ventana", () => {
    const tk = emitirToken(S, T0);
    expect(verificarToken(tk, S, T0 + 5000)).toEqual({ ok: true, emitido_en: T0 });
    expect(tk.length).toBeLessThanOrEqual(512);
  });

  it("limites: 3 s y 2 h inclusive; 1 ms fuera de cada lado -> token_vencido", () => {
    const tk = emitirToken(S, T0);
    expect(verificarToken(tk, S, T0 + TOKEN_EDAD_MIN_MS).ok).toBe(true);
    expect(verificarToken(tk, S, T0 + TOKEN_EDAD_MIN_MS - 1)).toEqual(VENCIDO);
    expect(verificarToken(tk, S, T0 + TOKEN_EDAD_MAX_MS).ok).toBe(true);
    expect(verificarToken(tk, S, T0 + TOKEN_EDAD_MAX_MS + 1)).toEqual(VENCIDO);
  });

  it("recien emitido (0 ms) y emitido en el futuro -> token_vencido", () => {
    const tk = emitirToken(S, T0);
    expect(verificarToken(tk, S, T0)).toEqual(VENCIDO);
    expect(verificarToken(tk, S, T0 - 10_000)).toEqual(VENCIDO);
  });

  it("firma ajena (otro secreto) -> token_vencido, mismo codigo que vencido", () => {
    expect(verificarToken(emitirToken(OTRO, T0), S, T0 + 10_000)).toEqual(VENCIDO);
  });

  it("timestamp alterado con la firma original -> token_vencido", () => {
    const [v, , firma] = emitirToken(S, T0).split(".");
    const alterado = `${v}.${T0 - 60_000}.${firma}`;
    expect(verificarToken(alterado, S, T0 + 10_000)).toEqual(VENCIDO);
  });

  it("firma alterada en un caracter -> token_vencido", () => {
    const tk = emitirToken(S, T0);
    const ult = tk.endsWith("A") ? "B" : "A";
    expect(verificarToken(tk.slice(0, -1) + ult, S, T0 + 10_000)).toEqual(VENCIDO);
  });

  it("malformados y no-string -> token_vencido", () => {
    const malos: unknown[] = [
      undefined, null, 42, {}, "", "abc", "v1.", "v1..x", `v1.${T0}`, `v1.${T0}.corta`,
      `v2.${T0}.${"A".repeat(43)}`, `v1.-1.${"A".repeat(43)}`, `v1.${T0}.${"A".repeat(44)}`,
      `v1.${T0}.${"!".repeat(43)}`, "v1.9999999999999999999999.AAAA", `${emitirToken(S, T0)} `,
    ];
    for (const m of malos) expect(verificarToken(m, S, T0 + 10_000)).toEqual(VENCIDO);
  });

  it("acepta secreto como bytes", () => {
    const k = new TextEncoder().encode(S);
    expect(verificarToken(emitirToken(k, T0), S, T0 + 10_000).ok).toBe(true);
  });

  it("secreto vacio o reloj invalido es error de programacion", () => {
    expect(() => emitirToken("", T0)).toThrow();
    expect(() => verificarToken(emitirToken(S, T0), "", T0 + 10_000)).toThrow();
    expect(() => emitirToken(S, Number.NaN)).toThrow();
  });

  it("la firma depende del timestamp y del secreto (tokens distintos)", () => {
    expect(emitirToken(S, T0)).not.toBe(emitirToken(S, T0 + 1));
    expect(emitirToken(S, T0)).not.toBe(emitirToken(OTRO, T0));
    expect(emitirToken(S, T0)).toBe(emitirToken(S, T0));
  });

  it("el token no contiene el secreto", () => {
    expect(emitirToken(S, T0)).not.toContain(S);
  });
});
