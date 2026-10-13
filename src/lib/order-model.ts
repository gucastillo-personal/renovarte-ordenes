/**
 * Modelo unico de orden para la entrega (B9; RFC rev. 4 9.1; AC-13, AC-16).
 *
 * Los dos canales (mail y Discord) se renderizan desde un mismo objeto
 * inmutable, `OrdenParaEntrega`. Se construye con una allowlist explicita:
 * nombre y presentacion salen del catalogo publicado (nunca del cliente) y
 * jamas se hace spread de un `ProductoCatalogo`, para que una clave extra
 * (p.ej. un costo) no pueda colarse al render.
 *
 * Modulo puro: sin I/O; el reloj entra por parametro (`ahoraMs`).
 */
import type { CrearOrdenRequest } from "../wire.js";
import type { Catalogo } from "./catalog.js";

export interface LineaEntrega {
  readonly nombre: string;
  readonly presentacion: string;
  readonly cantidad: number;
  /** ARS enteros: `precio_venta` del catalogo. */
  readonly precio_unitario: number;
  readonly subtotal: number;
}

export interface OrdenParaEntrega {
  readonly numero_orden: string;
  /** ISO-8601 UTC. */
  readonly recibida_en: string;
  /** Unicos datos personales (ADR-0020); nombre ya normalizado. */
  readonly contacto: Readonly<{ nombre: string; telefono: string }>;
  readonly lineas: readonly Readonly<LineaEntrega>[];
  readonly total: number;
}

export interface EntradaOrden {
  numero_orden: string;
  /** Reloj inyectado (ms epoch). */
  ahoraMs: number;
  contacto: { nombre: string; telefono: string };
  lineas: ReadonlyArray<{ producto_id: string; cantidad: number }>;
  catalogo: Catalogo;
}

export type ResultadoOrden =
  | { ok: true; orden: OrdenParaEntrega }
  | { ok: false; motivo: "producto_inexistente" };

/** Tipo del contacto del request, para que un cambio de contrato rompa aca. */
type _Contacto = CrearOrdenRequest["contacto"];

export function construirOrdenParaEntrega(entrada: EntradaOrden): ResultadoOrden {
  const lineas: LineaEntrega[] = [];
  let total = 0;
  for (const l of entrada.lineas) {
    const p = entrada.catalogo.get(l.producto_id);
    if (p === undefined) return { ok: false, motivo: "producto_inexistente" };
    const subtotal = p.precio_venta * l.cantidad;
    total += subtotal;
    lineas.push(
      Object.freeze({
        nombre: p.nombre,
        presentacion: p.presentacion,
        cantidad: l.cantidad,
        precio_unitario: p.precio_venta,
        subtotal,
      }),
    );
  }
  const contacto: _Contacto = { nombre: entrada.contacto.nombre, telefono: entrada.contacto.telefono };
  const orden: OrdenParaEntrega = Object.freeze({
    numero_orden: entrada.numero_orden,
    recibida_en: new Date(entrada.ahoraMs).toISOString(),
    contacto: Object.freeze({ nombre: contacto.nombre, telefono: contacto.telefono }),
    lineas: Object.freeze(lineas),
    total,
  });
  return { ok: true, orden };
}
