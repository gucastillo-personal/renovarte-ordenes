import { parseCatalogo } from "../../src/lib/catalog.js";
import { construirOrdenParaEntrega, type OrdenParaEntrega } from "../../src/lib/order-model.js";

const catalogo = parseCatalogo([
  {
    id: "A", proveedor: "p", categoria: "c", nombre: "Yerba suave", presentacion: "500 g",
    descripcion: "d", imagen: "i.jpg", precio_venta: 20000, en_oferta: false, tags: [],
  },
])!;

export const NOMBRE = "Zoilo Canarión";
export const TELEFONO = "+54 9 11 5550-1234";

export function ordenEntrega(): OrdenParaEntrega {
  const r = construirOrdenParaEntrega({
    numero_orden: "RA-48271",
    ahoraMs: Date.UTC(2026, 9, 13, 17, 5, 0),
    contacto: { nombre: NOMBRE, telefono: TELEFONO },
    lineas: [{ producto_id: "A", cantidad: 2 }],
    catalogo,
  });
  if (!r.ok) throw new Error("orden invalida");
  return r.orden;
}
