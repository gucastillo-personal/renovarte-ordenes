import { describe, expect, it } from "vitest";
import type { Catalogo } from "../src/lib/catalog.js";
import { checkOrder, sumaVista, verificarContraCatalogo, verificarTotalVisto } from "../src/lib/price-check.js";

const prod = (id: string, precio: number) => [id, { id, nombre: `Producto ${id}`, presentacion: "x", precio_venta: precio }] as const;
const catalogo: Catalogo = new Map([prod("A", 1000), prod("B", 250), prod("C", 40)]);

describe("price-check (AC-15)", () => {
  it("ok cuando precios y total coinciden", () => {
    const lineas = [
      { producto_id: "A", cantidad: 2, precio_visto: 1000 },
      { producto_id: "B", cantidad: 1, precio_visto: 250 },
    ];
    expect(checkOrder(lineas, 2250, catalogo)).toEqual({ ok: true });
  });

  it("precio_cambiado con precio_vigente; total_vigente con el precio nuevo", () => {
    const lineas = [
      { producto_id: "A", cantidad: 2, precio_visto: 900 },
      { producto_id: "B", cantidad: 1, precio_visto: 250 },
    ];
    expect(checkOrder(lineas, 2050, catalogo)).toEqual({
      ok: false,
      motivo: "rechazada_por_catalogo",
      lineas: [{ producto_id: "A", estado: "precio_cambiado", precio_vigente: 1000 }],
      total_vigente: 2250,
    });
  });

  it("producto inexistente -> no_disponible y no suma al total_vigente", () => {
    const lineas = [
      { producto_id: "ZZ", cantidad: 3, precio_visto: 10 },
      { producto_id: "C", cantidad: 2, precio_visto: 40 },
    ];
    expect(checkOrder(lineas, 110, catalogo)).toEqual({
      ok: false,
      motivo: "rechazada_por_catalogo",
      lineas: [{ producto_id: "ZZ", estado: "no_disponible" }],
      total_vigente: 80,
    });
  });

  it("varios problemas: solo las lineas con problema, en el orden recibido", () => {
    const lineas = [
      { producto_id: "C", cantidad: 1, precio_visto: 40 },
      { producto_id: "B", cantidad: 2, precio_visto: 1 },
      { producto_id: "ZZ", cantidad: 1, precio_visto: 5 },
    ];
    const r = checkOrder(lineas, 47, catalogo);
    expect(r).toMatchObject({
      motivo: "rechazada_por_catalogo",
      lineas: [
        { producto_id: "B", estado: "precio_cambiado", precio_vigente: 250 },
        { producto_id: "ZZ", estado: "no_disponible" },
      ],
      total_vigente: 540,
    });
  });

  it("total_visto inconsistente -> total_visto_inconsistente (antes que el catalogo)", () => {
    const lineas = [{ producto_id: "ZZ", cantidad: 1, precio_visto: 10 }];
    expect(checkOrder(lineas, 11, catalogo)).toEqual({ ok: false, motivo: "total_visto_inconsistente" });
  });

  it("helpers", () => {
    const lineas = [{ producto_id: "A", cantidad: 3, precio_visto: 1000 }];
    expect(sumaVista(lineas)).toBe(3000);
    expect(verificarTotalVisto(lineas, 3000)).toBe(true);
    expect(verificarTotalVisto(lineas, 2999)).toBe(false);
    expect(verificarContraCatalogo(lineas, catalogo)).toEqual({ ok: true });
  });

  it("el resultado no lleva nombres ni datos del catalogo mas alla del contrato", () => {
    const r = checkOrder([{ producto_id: "A", cantidad: 1, precio_visto: 1 }], 1, catalogo);
    expect(JSON.stringify(r)).not.toContain("Producto");
  });
});
