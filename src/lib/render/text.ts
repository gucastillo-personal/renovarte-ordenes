/**
 * Render de texto plano compartido (B9; RFC rev. 4 9.1; AC-13, AC-16).
 *
 * `renderTextoPlano` es la misma funcion para la parte `text/plain` del
 * mail y para el adjunto `.txt` de Discord. Tambien aloja los formateadores
 * (pesos, fecha) y la constante `LINEA_RELLENO`. Puro, sin I/O.
 */
import type { OrdenParaEntrega } from "../order-model.js";

/**
 * Primera linea del cuerpo (texto y HTML). Constante fija: sin datos
 * personales, sin numero ni total, sin variacion por orden. No pasa por el
 * logger. Decision del owner 2026-10-05b.
 */
export const LINEA_RELLENO =
  "Nueva orden recibida desde el sitio de RenovArte. Abrí el mensaje para ver el número de orden, los datos de contacto del cliente y los productos pedidos.";

export const PIE = "Pago y envío a coordinar con el cliente. Orden generada desde el sitio.";

export const ZONA_HORARIA = "America/Argentina/Buenos_Aires";

/** `64320` -> `$ 64.320` (sin depender de ICU). */
export function formatoPesos(n: number): string {
  const entero = Math.round(Math.abs(n)).toString();
  const conPuntos = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}$ ${conPuntos}`;
}

const FORMATO_FECHA = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONA_HORARIA,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** ISO UTC -> `13/10/2026 14:05` en America/Argentina/Buenos_Aires. */
export function formatoFechaHora(iso: string): string {
  const partes: Record<string, string> = {};
  for (const p of FORMATO_FECHA.formatToParts(new Date(iso))) partes[p.type] = p.value;
  return `${partes["day"]}/${partes["month"]}/${partes["year"]} ${partes["hour"]}:${partes["minute"]}`;
}

export function textoProductos(n: number): string {
  return n === 1 ? "1 producto" : `${n} productos`;
}

/** Orden completa en texto plano; empieza con `LINEA_RELLENO`. */
export function renderTextoPlano(orden: OrdenParaEntrega): string {
  const out: string[] = [
    LINEA_RELLENO,
    "",
    `Número de orden: ${orden.numero_orden}`,
    `Fecha y hora: ${formatoFechaHora(orden.recibida_en)} (hora de Argentina)`,
    "",
    `Nombre y apellido: ${orden.contacto.nombre}`,
    `Teléfono: ${orden.contacto.telefono}`,
    "",
    "Productos:",
  ];
  for (const l of orden.lineas) {
    out.push(
      `- ${l.nombre} (${l.presentacion}) x ${l.cantidad} · unitario ${formatoPesos(l.precio_unitario)} · subtotal ${formatoPesos(l.subtotal)}`,
    );
  }
  out.push("", `Total: ${formatoPesos(orden.total)}`, "", PIE, "");
  return out.join("\n");
}
