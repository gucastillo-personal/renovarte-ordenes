import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  STALE_MAX_MS,
  createCatalog,
  type FetchLike,
} from "../src/lib/catalog.js";

// Valores ficticios (repo publico).
const fila = (id: string, precio: number, extra: Record<string, unknown> = {}) => ({
  id,
  proveedor: "PROV",
  categoria: "Cat",
  nombre: `Producto ${id}`,
  presentacion: "10 ml",
  descripcion: "d",
  imagen: "/i.png",
  precio_venta: precio,
  en_oferta: false,
  tags: [],
  ...extra,
});

type Resp = { status: number; etag?: string; body?: unknown; badJson?: boolean; cuelga?: boolean };

function setup(respuestas: Resp[]) {
  let t = 1_000_000;
  const llamadas: Array<Record<string, string>> = [];
  const fetch: FetchLike = (_url, init) => {
    llamadas.push(init.headers);
    const r = respuestas.shift();
    if (r === undefined) throw new Error("sin respuesta preparada");
    if (r.cuelga) return new Promise(() => undefined);
    return Promise.resolve({
      status: r.status,
      headers: { get: (n: string) => (n.toLowerCase() === "etag" ? (r.etag ?? null) : null) },
      json: () => (r.badJson ? Promise.reject(new Error("json")) : Promise.resolve(r.body)),
    });
  };
  const cat = createCatalog({ url: "https://catalogo.invalid/data/products.json", fetch, now: () => t, timeoutMs: 20 });
  return { cat, llamadas, avanzar: (ms: number) => (t += ms), restantes: () => respuestas.length };
}

describe("catalog", () => {
  it("200: devuelve el mapa por id con solo la allowlist", async () => {
    const { cat } = setup([{ status: 200, body: [fila("A", 100, { costo: 5, precio_lista_laca: 9, margen: 1 })] }]);
    const r = await cat.get();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.catalogo.get("A");
    expect(p).toEqual({ id: "A", nombre: "Producto A", presentacion: "10 ml", precio_venta: 100 });
    expect(Object.keys(p ?? {}).sort()).toEqual(["id", "nombre", "precio_venta", "presentacion"]);
    expect(JSON.stringify([...r.catalogo.values()])).not.toMatch(/costo|margen|laca|proveedor/i);
  });

  it("cache de 5 min: no vuelve a pedir; despues revalida con If-None-Match y 304", async () => {
    const { cat, llamadas, avanzar } = setup([
      { status: 200, etag: '"v1"', body: [fila("A", 100)] },
      { status: 304 },
    ]);
    await cat.get();
    avanzar(CACHE_TTL_MS - 1);
    await cat.get();
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0]?.["if-none-match"]).toBeUndefined();
    avanzar(2);
    const r = await cat.get();
    expect(llamadas).toHaveLength(2);
    expect(llamadas[1]?.["if-none-match"]).toBe('"v1"');
    expect(r.ok && r.catalogo.get("A")?.precio_venta).toBe(100);
    // el 304 reinicia la ventana de 5 min
    avanzar(CACHE_TTL_MS - 1);
    await cat.get();
    expect(llamadas).toHaveLength(2);
  });

  it("forceRefresh ignora la cache y toma el catalogo nuevo", async () => {
    const { cat, llamadas } = setup([
      { status: 200, etag: '"v1"', body: [fila("A", 100)] },
      { status: 200, etag: '"v2"', body: [fila("A", 150)] },
    ]);
    await cat.get();
    const r = await cat.forceRefresh();
    expect(llamadas).toHaveLength(2);
    expect(llamadas[1]?.["if-none-match"]).toBe('"v1"');
    expect(r.ok && r.catalogo.get("A")?.precio_venta).toBe(150);
    expect((await cat.get()).ok).toBe(true);
    expect(llamadas).toHaveLength(2);
  });

  it("llamadas concurrentes comparten una sola descarga", async () => {
    const { cat, llamadas } = setup([{ status: 200, body: [fila("A", 1)] }]);
    await Promise.all([cat.get(), cat.get(), cat.forceRefresh()]);
    expect(llamadas).toHaveLength(1);
  });

  it("5xx sin copia -> catalogo_no_disponible", async () => {
    const { cat } = setup([{ status: 503 }]);
    expect(await cat.get()).toEqual({ ok: false, codigo: "catalogo_no_disponible" });
  });

  it("304 sin copia previa no se acepta", async () => {
    const { cat } = setup([{ status: 304 }]);
    expect(await cat.get()).toEqual({ ok: false, codigo: "catalogo_no_disponible" });
  });

  it("5xx con copia < 24 h sirve la copia; a las 24 h deja de servirla", async () => {
    const { cat, avanzar } = setup([
      { status: 200, body: [fila("A", 100)] },
      { status: 500 },
      { status: 500 },
    ]);
    await cat.get();
    avanzar(CACHE_TTL_MS + 1);
    const r = await cat.get();
    expect(r.ok && r.catalogo.get("A")?.precio_venta).toBe(100);
    avanzar(STALE_MAX_MS);
    expect(await cat.get()).toEqual({ ok: false, codigo: "catalogo_no_disponible" });
  });

  it("la copia vieja no se rejuvenece con fallas: cuenta desde la ultima confirmacion", async () => {
    const { cat, avanzar } = setup([
      { status: 200, body: [fila("A", 100)] },
      { status: 500 },
      { status: 500 },
    ]);
    await cat.get();
    avanzar(STALE_MAX_MS - 1000);
    expect((await cat.get()).ok).toBe(true);
    avanzar(1000);
    expect((await cat.get()).ok).toBe(false);
  });

  it("JSON invalido -> falla (con copia previa, se conserva la anterior)", async () => {
    const { cat, avanzar } = setup([
      { status: 200, body: [fila("A", 100)] },
      { status: 200, badJson: true },
    ]);
    await cat.get();
    avanzar(CACHE_TTL_MS + 1);
    const r = await cat.get();
    expect(r.ok && r.catalogo.get("A")?.precio_venta).toBe(100);
  });

  it("JSON invalido sin copia, y cuerpo que no es array -> no disponible", async () => {
    expect(await setup([{ status: 200, badJson: true }]).cat.get()).toEqual({ ok: false, codigo: "catalogo_no_disponible" });
    expect(await setup([{ status: 200, body: { a: 1 } }]).cat.get()).toEqual({ ok: false, codigo: "catalogo_no_disponible" });
  });

  it("una fila invalida invalida todo el archivo", async () => {
    const { cat } = setup([{ status: 200, body: [fila("A", 100), { ...fila("B", 1), precio_venta: "1" }] }]);
    expect(await cat.get()).toEqual({ ok: false, codigo: "catalogo_no_disponible" });
  });

  it("ids repetidos invalidan el archivo", async () => {
    const { cat } = setup([{ status: 200, body: [fila("A", 100), fila("A", 200)] }]);
    expect((await cat.get()).ok).toBe(false);
  });

  it("guard de oferta: precio_regular y descuento_pct juntos y coherentes", async () => {
    const buena = fila("A", 80, { precio_regular: 100, descuento_pct: 20 });
    expect((await setup([{ status: 200, body: [buena] }]).cat.get()).ok).toBe(true);
    const sola = fila("A", 80, { precio_regular: 100 });
    expect((await setup([{ status: 200, body: [sola] }]).cat.get()).ok).toBe(false);
  });

  it("timeout de la descarga -> falla, aunque el fetch ignore la senal", async () => {
    const { cat } = setup([{ status: 200, cuelga: true }]);
    expect(await cat.get()).toEqual({ ok: false, codigo: "catalogo_no_disponible" });
  });

  it("fetch que lanza -> falla", async () => {
    const cat = createCatalog({
      url: "https://catalogo.invalid/p.json",
      fetch: () => Promise.reject(new Error("red")),
      now: () => 0,
    });
    expect(await cat.get()).toEqual({ ok: false, codigo: "catalogo_no_disponible" });
  });
});
