/**
 * Render del mail (B9; RFC rev. 4 9.1; AC-13, AC-16).
 *
 * Puro: recibe solo `OrdenParaEntrega`. El asunto no lleva datos
 * personales (ni nombre ni telefono). El cuerpo (texto y HTML) arranca con
 * `LINEA_RELLENO`; el contacto va despues, junto a numero y fecha. En el
 * HTML todo valor se escapa, el nombre incluido.
 */
import type { OrdenParaEntrega } from "../order-model.js";
import {
  LINEA_RELLENO,
  PIE,
  formatoFechaHora,
  formatoPesos,
  renderTextoPlano,
  textoProductos,
} from "../render/text.js";

export interface MailRenderizado {
  asunto: string;
  texto: string;
  html: string;
}

export function escaparHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMail(orden: OrdenParaEntrega): MailRenderizado {
  const e = escaparHtml;
  const asunto = `Nueva orden ${orden.numero_orden} · ${formatoPesos(orden.total)} · ${textoProductos(orden.lineas.length)}`;
  const filas = orden.lineas
    .map(
      (l) =>
        `<tr><td>${e(l.nombre)}</td><td>${e(l.presentacion)}</td><td>${l.cantidad}</td><td>${e(formatoPesos(l.precio_unitario))}</td><td>${e(formatoPesos(l.subtotal))}</td></tr>`,
    )
    .join("");
  const html =
    `<!doctype html><html lang="es"><body>` +
    `<p>${e(LINEA_RELLENO)}</p>` +
    `<p>Número de orden: ${e(orden.numero_orden)}<br>Fecha y hora: ${e(formatoFechaHora(orden.recibida_en))} (hora de Argentina)</p>` +
    `<p>Nombre y apellido: ${e(orden.contacto.nombre)}<br>Teléfono: ${e(orden.contacto.telefono)}</p>` +
    `<table border="1" cellpadding="4" cellspacing="0"><thead><tr><th>Producto</th><th>Presentación</th><th>Cantidad</th><th>Unitario</th><th>Subtotal</th></tr></thead><tbody>${filas}</tbody></table>` +
    `<p><strong>Total: ${e(formatoPesos(orden.total))}</strong></p>` +
    `<p>${e(PIE)}</p>` +
    `</body></html>`;
  return { asunto, texto: renderTextoPlano(orden), html };
}
