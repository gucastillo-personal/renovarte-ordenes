/**
 * Validacion de precios contra el catalogo (B6; RFC rev. 4 4.3; AC-15).
 *
 * Funcion pura, sin I/O. Rechaza en lugar de corregir (decision de ux.md):
 * ante cualquier linea con problema el resultado es el contenido de un
 * `409 rechazada_por_catalogo` y no se entrega nada. Los precios del
 * cliente jamas se usan para nada salvo compararlos.
 *
 * Separado en dos pasos porque el segundo depende del catalogo y el
 * primero no (el handler puede correr `verificarTotalVisto` antes de
 * pedir el catalogo, RFC 6.5 paso 3):
 * - `verificarTotalVisto`: `total_visto === sum(precio_visto x cantidad)`.
 * - `verificarContraCatalogo`: inexistente -> `no_disponible`;
 *   `precio_visto !== precio_venta` -> `precio_cambiado`.
 * - `checkOrder`: ambos, el total primero.
 *
 * Sin contacto ni valores del visitante en los resultados.
 */
import type { CrearOrdenResponse } from "../wire.js";
import type { Catalogo } from "./catalog.js";

export interface LineaPrecio {
  producto_id: string;
  cantidad: number;
  precio_visto: number;
}

export type LineaConProblema = Extract<
  CrearOrdenResponse,
  { resultado: "rechazada_por_catalogo" }
>["lineas"][number];

export type ResultadoPrecios =
  | { ok: true }
  | { ok: false; motivo: "total_visto_inconsistente" }
  | { ok: false; motivo: "rechazada_por_catalogo"; lineas: LineaConProblema[]; total_vigente: number };

/** Σ precio_visto × cantidad (lo que el visitante vio). */
export function sumaVista(lineas: readonly LineaPrecio[]): number {
  return lineas.reduce((acc, l) => acc + l.precio_visto * l.cantidad, 0);
}

/** `true` si `total_visto` coincide con la suma de sus propias lineas. */
export function verificarTotalVisto(lineas: readonly LineaPrecio[], totalVisto: number): boolean {
  return totalVisto === sumaVista(lineas);
}

/**
 * Compara cada linea con el catalogo. `total_vigente` = Σ precio vigente ×
 * cantidad sobre las lineas disponibles (Q-F6): las que no tienen problema
 * aportan su `precio_visto`, que es el vigente; las `no_disponible` no
 * aportan nada. Solo se devuelven las lineas con problema, en el orden
 * recibido.
 */
export function verificarContraCatalogo(
  lineas: readonly LineaPrecio[],
  catalogo: Catalogo,
): { ok: true } | { ok: false; lineas: LineaConProblema[]; total_vigente: number } {
  const problemas: LineaConProblema[] = [];
  let totalVigente = 0;
  for (const l of lineas) {
    const p = catalogo.get(l.producto_id);
    if (p === undefined) {
      problemas.push({ producto_id: l.producto_id, estado: "no_disponible" });
      continue;
    }
    totalVigente += p.precio_venta * l.cantidad;
    if (p.precio_venta !== l.precio_visto) {
      problemas.push({
        producto_id: l.producto_id,
        estado: "precio_cambiado",
        precio_vigente: p.precio_venta,
      });
    }
  }
  return problemas.length === 0 ? { ok: true } : { ok: false, lineas: problemas, total_vigente: totalVigente };
}

export function checkOrder(
  lineas: readonly LineaPrecio[],
  totalVisto: number,
  catalogo: Catalogo,
): ResultadoPrecios {
  if (!verificarTotalVisto(lineas, totalVisto)) return { ok: false, motivo: "total_visto_inconsistente" };
  const r = verificarContraCatalogo(lineas, catalogo);
  if (r.ok) return { ok: true };
  return { ok: false, motivo: "rechazada_por_catalogo", lineas: r.lineas, total_vigente: r.total_vigente };
}
