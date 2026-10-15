import { describe, expect, it } from "vitest";
import {
  calcularPayloadHmac,
  derivarClave,
  huellasIguales,
  payloadCanonico,
  type PayloadParaHuella,
} from "../src/lib/payload-hmac.js";

const SECRETO = "secreto-de-prueba";
const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const base = (): PayloadParaHuella => ({
  v: 1,
  idempotency_key: KEY,
  lineas: [
    { producto_id: "b-2", cantidad: 1, precio_visto: 500 },
    { producto_id: "a-1", cantidad: 2, precio_visto: 1000 },
  ],
  total_visto: 2500,
  contacto: { nombre: "Zoe Canario", telefono: "11 5555-0123" },
});

describe("payload-hmac (B11, RFC 5.4.1)", () => {
  it("devuelve 256 bits sin truncar (64 hex) y es determinista", () => {
    const h = calcularPayloadHmac(SECRETO, base());
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(calcularPayloadHmac(SECRETO, base())).toBe(h);
  });

  it("canonico: array de orden fijo, lineas ordenadas por producto_id", () => {
    expect(payloadCanonico(base())).toBe(
      JSON.stringify([1, [["a-1", 2, 1000], ["b-2", 1, 500]], 2500, "Zoe Canario", "11 5555-0123"]),
    );
  });

  it("el orden de las lineas no cambia la huella", () => {
    const p = base();
    const q = { ...base(), lineas: [...p.lineas].reverse() };
    expect(calcularPayloadHmac(SECRETO, q)).toBe(calcularPayloadHmac(SECRETO, p));
  });

  it("nombre normalizado y telefono recortado dan la misma huella", () => {
    const q = base();
    q.contacto = { nombre: "  Zoe \t Canario ", telefono: "  11 5555-0123  " };
    expect(calcularPayloadHmac(SECRETO, q)).toBe(calcularPayloadHmac(SECRETO, base()));
    const nfd = base();
    nfd.contacto = { nombre: "José Perez", telefono: "1155550123" };
    const nfc = base();
    nfc.contacto = { nombre: "José Perez", telefono: "1155550123" };
    expect(calcularPayloadHmac(SECRETO, nfd)).toBe(calcularPayloadHmac(SECRETO, nfc));
  });

  it("cambiar nombre o telefono da otra huella", () => {
    const h = calcularPayloadHmac(SECRETO, base());
    const n = base();
    n.contacto = { ...n.contacto, nombre: "Zoe Canarias" };
    const t = base();
    t.contacto = { ...t.contacto, telefono: "11 5555-0124" };
    expect(calcularPayloadHmac(SECRETO, n)).not.toBe(h);
    expect(calcularPayloadHmac(SECRETO, t)).not.toBe(h);
  });

  it("cambiar lineas, cantidad, precio o total da otra huella", () => {
    const h = calcularPayloadHmac(SECRETO, base());
    const a = base();
    a.lineas[0]!.cantidad = 2;
    const b = { ...base(), total_visto: 2501 };
    expect(calcularPayloadHmac(SECRETO, a)).not.toBe(h);
    expect(calcularPayloadHmac(SECRETO, b)).not.toBe(h);
  });

  it("misma carga con otra key da otra huella (no relacionables)", () => {
    const otra = { ...base(), idempotency_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    expect(calcularPayloadHmac(SECRETO, otra)).not.toBe(calcularPayloadHmac(SECRETO, base()));
    expect(derivarClave(SECRETO, KEY).equals(derivarClave(SECRETO, otra.idempotency_key))).toBe(false);
  });

  it("otro secreto da otra huella; secreto o key vacios lanzan", () => {
    expect(calcularPayloadHmac("otro-secreto", base())).not.toBe(calcularPayloadHmac(SECRETO, base()));
    expect(() => calcularPayloadHmac("", base())).toThrow();
    expect(() => calcularPayloadHmac(SECRETO, { ...base(), idempotency_key: "" })).toThrow();
  });

  it("la huella no contiene el nombre ni el telefono", () => {
    const h = calcularPayloadHmac(SECRETO, base());
    expect(h).not.toContain("Canario");
    expect(h).not.toContain("5555");
    expect(h).not.toContain(Buffer.from("Zoe Canario").toString("hex"));
  });

  it("huellasIguales compara bien y rechaza largos o tipos invalidos", () => {
    const h = calcularPayloadHmac(SECRETO, base());
    expect(huellasIguales(h, h)).toBe(true);
    expect(huellasIguales(h, calcularPayloadHmac(SECRETO, { ...base(), total_visto: 1 }))).toBe(false);
    expect(huellasIguales(h, h.slice(0, 32))).toBe(false);
    expect(huellasIguales(h, "z".repeat(64))).toBe(false);
    expect(huellasIguales(h, undefined)).toBe(false);
    expect(huellasIguales(null, h)).toBe(false);
  });
});
