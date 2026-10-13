import { describe, expect, it } from "vitest";
import { parseCatalogo } from "../src/lib/catalog.js";
import { renderDiscord } from "../src/lib/discord/render.js";
import { renderMail } from "../src/lib/mail/render.js";
import { construirOrdenParaEntrega, type OrdenParaEntrega } from "../src/lib/order-model.js";

const fila = (id: string, nombre: string, precio: number, extra: Record<string, unknown> = {}) => ({
  id, proveedor: "p", categoria: "c", nombre, presentacion: "500 g", descripcion: "d", imagen: "i.jpg",
  precio_venta: precio, en_oferta: false, tags: [], ...extra,
});
const CLAVES = { costo: 777001, margen: 888002, precio_lista_laca: 999003, costo_proveedor: 666004 };
const NOMBRE_LARGO_PROD = "Producto de nombre bastante largo para ocupar lugar en el mensaje ".repeat(2).trim();
const catalogo = parseCatalogo([
  fila("A", "Yerba suave", 20000, CLAVES),
  fila("B", "Miel", 12160, CLAVES),
  fila("L", NOMBRE_LARGO_PROD, 1234567, CLAVES),
])!;

const AHORA = Date.UTC(2026, 9, 13, 17, 5, 0);
const TEL = "+54 9 11 5550-1234";

function orden(nombre = "Zoilo Canarión", lineas = [{ producto_id: "A", cantidad: 3 }, { producto_id: "B", cantidad: 1 }]): OrdenParaEntrega {
  const r = construirOrdenParaEntrega({
    numero_orden: "RA-48271", ahoraMs: AHORA, contacto: { nombre, telefono: TEL }, lineas, catalogo,
  });
  if (!r.ok) throw new Error("orden invalida");
  return r.orden;
}
const primeraLinea = (c: string) => c.split("\n")[0]!;
const bloques = (c: string) => c.split("```").length - 1;

describe("renderDiscord", () => {
  it("payload: username fijo, sin menciones, flags 4, adjunto = texto del mail", () => {
    const o = orden();
    const { payload, adjunto } = renderDiscord(o);
    expect(payload.username).not.toContain("Zoilo");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.flags).toBe(4);
    expect(payload.attachments).toEqual([{ id: 0, filename: "orden-RA-48271.txt" }]);
    expect(adjunto.filename).toBe("orden-RA-48271.txt");
    expect(adjunto.contenido).toBe(renderMail(o).texto);
  });
  it("primera linea con numero, total y cantidad; sin nombre ni telefono; mismo numero que el mail", () => {
    const o = orden();
    const { payload } = renderDiscord(o);
    expect(primeraLinea(payload.content)).toBe("Nueva orden RA-48271 · $ 72.160 · 2 productos");
    expect(renderMail(o).asunto).toContain("RA-48271");
    expect(payload.content.split("\n")[1]).toBe("13/10/2026 14:05 (hora de Argentina)");
    expect(payload.content.slice(0, payload.content.indexOf("```"))).not.toMatch(/Zoilo|5550/);
  });
  it("contacto y productos dentro del bloque de codigo", () => {
    const { payload } = renderDiscord(orden());
    const dentro = payload.content.split("```")[1]!;
    expect(dentro).toContain("Nombre: Zoilo Canarión");
    expect(dentro).toContain(`Teléfono: ${TEL}`);
    expect(dentro).toContain("- Yerba suave (500 g) x 3");
    expect(dentro).toContain("Total: $ 72.160");
    expect(bloques(payload.content)).toBe(2);
  });
  it("100 lineas con nombre de 80 caracteres: content <= 1.900, total visible, resumen", () => {
    const nombre = "Ñ".repeat(80);
    const lineas = Array.from({ length: 100 }, () => ({ producto_id: "L", cantidad: 99 }));
    const o = orden(nombre, lineas);
    const { payload, adjunto } = renderDiscord(o);
    expect(payload.content.length).toBeLessThanOrEqual(1900);
    expect(payload.content).toMatch(/… y \d+ productos más: ver el adjunto/);
    expect(payload.content).toContain(`Total: $ ${o.total.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`);
    expect(primeraLinea(payload.content)).toContain("100 productos");
    expect(adjunto.contenido.split("\n").filter((l) => l.startsWith("- ")).length).toBe(100);
    expect(bloques(payload.content)).toBe(2);
  });
  it("encabezado + contacto con nombre de 80 caracteres <= ~400", () => {
    const { payload } = renderDiscord(orden("Ñ".repeat(80)));
    const hasta = payload.content.indexOf("Productos:");
    expect(hasta).toBeLessThanOrEqual(400);
  });
  it("sin recorte cuando entra todo (sin 'mas')", () => {
    expect(renderDiscord(orden()).payload.content).not.toContain("más: ver el adjunto");
  });
  it.each(["@everyone", "```", "[link](http://x)", "**", "a`b`c", "@here <@123>"])(
    "nombre %j no rompe el bloque ni menciona",
    (nombre) => {
      const { payload } = renderDiscord(orden(nombre));
      expect(bloques(payload.content)).toBe(2);
      expect(payload.content.match(/`/g)!.length).toBe(6);
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      expect(payload.username).not.toContain(nombre);
      expect(primeraLinea(payload.content)).not.toContain(nombre);
      if (nombre.includes("`")) expect(payload.content).toContain("ˋ");
    },
  );
  it("sin tokens prohibidos (AC-16)", () => {
    const { payload, adjunto } = renderDiscord(orden());
    const todo = JSON.stringify(payload) + adjunto.contenido;
    for (const v of Object.values(CLAVES)) expect(todo).not.toContain(String(v));
    expect(todo).not.toMatch(/costo|margen|laca|precio_lista/i);
  });
});
