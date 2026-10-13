import { describe, expect, it } from "vitest";
import { parseCatalogo } from "../src/lib/catalog.js";
import { renderMail } from "../src/lib/mail/render.js";
import { construirOrdenParaEntrega, type OrdenParaEntrega } from "../src/lib/order-model.js";
import { LINEA_RELLENO, formatoFechaHora, formatoPesos, renderTextoPlano } from "../src/lib/render/text.js";

const fila = (id: string, nombre: string, precio: number, extra: Record<string, unknown> = {}) => ({
  id, proveedor: "p", categoria: "c", nombre, presentacion: "500 g", descripcion: "d", imagen: "i.jpg",
  precio_venta: precio, en_oferta: false, tags: [], ...extra,
});

// Claves de costo inyectadas en el catalogo (AC-16): no deben llegar al render.
const CLAVES = { costo: 777001, margen: 888002, precio_lista_laca: 999003, costo_proveedor: 666004 };
const catalogo = parseCatalogo([
  fila("A", "Yerba suave", 20000, CLAVES),
  fila("B", "Miel", 12160, CLAVES),
])!;

// 2026-10-13T17:05:00Z = 14:05 en Buenos Aires (UTC-3)
const AHORA = Date.UTC(2026, 9, 13, 17, 5, 0);
const NOMBRE = "Zoilo Canarión";
const TEL = "+54 9 11 5550-1234";

function orden(nombre = NOMBRE): OrdenParaEntrega {
  const r = construirOrdenParaEntrega({
    numero_orden: "RA-48271",
    ahoraMs: AHORA,
    contacto: { nombre, telefono: TEL },
    lineas: [
      { producto_id: "A", cantidad: 3 },
      { producto_id: "B", cantidad: 1 },
    ],
    catalogo,
  });
  if (!r.ok) throw new Error("orden invalida");
  return r.orden;
}

describe("order-model", () => {
  it("toma nombre/presentacion/precio del catalogo y calcula total", () => {
    const o = orden();
    expect(o.total).toBe(72160);
    expect(o.lineas[0]).toEqual({
      nombre: "Yerba suave", presentacion: "500 g", cantidad: 3, precio_unitario: 20000, subtotal: 60000,
    });
    expect(o.recibida_en).toBe("2026-10-13T17:05:00.000Z");
  });
  it("allowlist: ninguna clave extra del catalogo en el objeto", () => {
    const json = JSON.stringify(orden());
    for (const v of Object.values(CLAVES)) expect(json).not.toContain(String(v));
    expect(Object.keys(orden().lineas[0]!).sort()).toEqual(
      ["cantidad", "nombre", "precio_unitario", "presentacion", "subtotal"],
    );
  });
  it("es inmutable", () => {
    const o = orden();
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(o.lineas)).toBe(true);
    expect(Object.isFrozen(o.contacto)).toBe(true);
  });
  it("producto inexistente -> error", () => {
    const r = construirOrdenParaEntrega({
      numero_orden: "RA-1", ahoraMs: AHORA, contacto: { nombre: NOMBRE, telefono: TEL },
      lineas: [{ producto_id: "ZZ", cantidad: 1 }], catalogo,
    });
    expect(r).toEqual({ ok: false, motivo: "producto_inexistente" });
  });
});

describe("formatos", () => {
  it("pesos", () => {
    expect(formatoPesos(64320)).toBe("$ 64.320");
    expect(formatoPesos(950)).toBe("$ 950");
    expect(formatoPesos(1234567)).toBe("$ 1.234.567");
  });
  it("fecha en America/Argentina/Buenos_Aires", () => {
    expect(formatoFechaHora("2026-10-13T17:05:00.000Z")).toBe("13/10/2026 14:05");
    // cruce de dia: 02:30 UTC del 14 es 23:30 del 13 en Argentina
    expect(formatoFechaHora("2026-10-14T02:30:00.000Z")).toBe("13/10/2026 23:30");
  });
});

describe("LINEA_RELLENO", () => {
  it("tiene 153 caracteres y no lleva datos de la orden", () => {
    expect(LINEA_RELLENO.length).toBe(153);
    expect(LINEA_RELLENO).not.toMatch(/RA-|\$|\d/);
  });
});

describe("renderMail (AC-13)", () => {
  const m = renderMail(orden());
  it("asunto sin nombre ni telefono", () => {
    expect(m.asunto).toBe("Nueva orden RA-48271 · $ 72.160 · 2 productos");
    expect(m.asunto).not.toContain("Zoilo");
    expect(m.asunto).not.toContain("5550");
  });
  it("nombre y telefono en el cuerpo, despues de la linea de relleno", () => {
    for (const cuerpo of [m.texto, m.html]) {
      expect(cuerpo).toContain(NOMBRE);
      expect(cuerpo).toContain(TEL);
      expect(cuerpo).toContain("RA-48271");
    }
    expect(m.texto).toContain(`Nombre y apellido: ${NOMBRE}`);
    expect(m.texto).toContain(`Teléfono: ${TEL}`);
    expect(m.texto).toContain("13/10/2026 14:05");
    expect(m.texto).toContain("$ 72.160");
  });
  it("texto y HTML empiezan con LINEA_RELLENO; dos ordenes dan el mismo arranque", () => {
    const otra = renderMail(
      (() => {
        const r = construirOrdenParaEntrega({
          numero_orden: "RA-00001", ahoraMs: AHORA + 86_400_000,
          contacto: { nombre: "Otra Persona", telefono: "1144443333" },
          lineas: [{ producto_id: "B", cantidad: 2 }], catalogo,
        });
        if (!r.ok) throw new Error("x");
        return r.orden;
      })(),
    );
    expect(m.texto.startsWith(LINEA_RELLENO)).toBe(true);
    expect(m.html).toContain(`<body><p>${LINEA_RELLENO}</p>`);
    expect(otra.texto.slice(0, 153)).toBe(m.texto.slice(0, 153));
    expect(otra.html.slice(0, 200)).toBe(m.html.slice(0, 200));
  });
  it("los primeros 153 caracteres no contienen nombre, telefono ni numero", () => {
    const ini = m.texto.slice(0, 153);
    expect(ini).not.toContain("Zoilo");
    expect(ini).not.toContain("5550");
    expect(ini).not.toContain("RA-");
    const iniHtml = m.html.slice(0, m.html.indexOf(LINEA_RELLENO) + 153);
    expect(iniHtml).not.toContain("Zoilo");
    expect(iniHtml).not.toContain("RA-48271");
  });
  it("nombre con <script>, & y comillas: escapado en HTML, literal en texto", () => {
    const raro = `<script>alert("x")</script> & O'Neil`;
    const mm = renderMail(orden(raro));
    expect(mm.html).not.toContain("<script>");
    expect(mm.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; O&#39;Neil");
    expect(mm.texto).toContain(`Nombre y apellido: ${raro}`);
    expect(mm.asunto).not.toContain("script");
  });
  it("texto del mail == adjunto (misma funcion)", () => {
    expect(m.texto).toBe(renderTextoPlano(orden()));
  });
});

describe("tokens prohibidos (AC-16)", () => {
  it("ni el texto ni el HTML ni el asunto llevan claves ni valores de costo", () => {
    const m = renderMail(orden());
    const todo = `${m.asunto}\n${m.texto}\n${m.html}`;
    for (const v of Object.values(CLAVES)) expect(todo).not.toContain(String(v));
    expect(todo).not.toMatch(/costo|margen|laca|precio_lista/i);
  });
});
