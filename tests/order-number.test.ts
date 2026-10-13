import { describe, expect, it } from "vitest";
import {
  NUMERO_MAX_INTENTOS,
  esNumeroOrden,
  generarNumero,
  reservarNumero,
  type NumeroStore,
} from "../src/lib/order-number.js";

function storeEn(usadas: Set<string>): NumeroStore & { llamadas: string[] } {
  const llamadas: string[] = [];
  return {
    llamadas,
    async reservar(pk) {
      llamadas.push(pk);
      if (usadas.has(pk)) return false;
      usadas.add(pk);
      return true;
    },
  };
}

function secuencia(...nums: string[]): () => string {
  let i = 0;
  return () => nums[Math.min(i++, nums.length - 1)] as string;
}

describe("order-number (B8, AC-10)", () => {
  it("generarNumero respeta el formato RA- + 5 digitos", () => {
    for (let i = 0; i < 500; i++) expect(generarNumero()).toMatch(/^RA-[0-9]{5}$/);
  });

  it("esNumeroOrden valida el formato", () => {
    expect(esNumeroOrden("RA-48271")).toBe(true);
    expect(esNumeroOrden("RA-00007")).toBe(true);
    for (const x of ["RA-4827", "RA-482711", "ra-48271", "RA-4827a", " RA-48271", 48271, null]) {
      expect(esNumeroOrden(x)).toBe(false);
    }
  });

  it("reserva a la primera con clave NUM#", async () => {
    const store = storeEn(new Set());
    const r = await reservarNumero({ store, generar: secuencia("RA-48271") });
    expect(r).toEqual({ ok: true, numero: "RA-48271", intentos: 1 });
    expect(store.llamadas).toEqual(["NUM#RA-48271"]);
  });

  it("colision -> reintenta con otro numero", async () => {
    const store = storeEn(new Set(["NUM#RA-11111"]));
    const r = await reservarNumero({ store, generar: secuencia("RA-11111", "RA-22222") });
    expect(r).toEqual({ ok: true, numero: "RA-22222", intentos: 2 });
    expect(store.llamadas).toEqual(["NUM#RA-11111", "NUM#RA-22222"]);
  });

  it("5 colisiones -> falla/interno, sin un sexto intento", async () => {
    const usadas = new Set(["NUM#RA-00001"]);
    const store = storeEn(usadas);
    const r = await reservarNumero({ store, generar: secuencia("RA-00001") });
    expect(r).toEqual({ ok: false, resultado: "falla", codigo: "interno" });
    expect(store.llamadas).toHaveLength(NUMERO_MAX_INTENTOS);
  });

  it("la quinta oportunidad todavia cuenta", async () => {
    const store = storeEn(new Set(["NUM#RA-00001"]));
    const gen = secuencia("RA-00001", "RA-00001", "RA-00001", "RA-00001", "RA-00002");
    expect(await reservarNumero({ store, generar: gen })).toEqual({
      ok: true,
      numero: "RA-00002",
      intentos: 5,
    });
  });

  it("un error del store se propaga (no es colision)", async () => {
    const store: NumeroStore = {
      async reservar() {
        throw new Error("dynamo caido");
      },
    };
    await expect(reservarNumero({ store, generar: secuencia("RA-12345") })).rejects.toThrow("dynamo caido");
  });

  it("un generador que devuelve formato invalido lanza", async () => {
    const store = storeEn(new Set());
    await expect(reservarNumero({ store, generar: () => "RA-1" })).rejects.toThrow();
    expect(store.llamadas).toHaveLength(0);
  });
});
