/**
 * Render del mensaje de Discord (B21; RFC rev. 4 9.1 y 10.2; AC-16, AC-23).
 *
 * Puro: recibe solo `OrdenParaEntrega`. La primera linea (fuera del bloque)
 * lleva solo datos del servidor: numero, total y cantidad de productos; sin
 * nombre ni telefono. Contacto y productos van dentro de un bloque de codigo
 * con cada backtick reemplazado por U+02CB. El nombre nunca va en `username`.
 * `allowed_mentions: {parse: []}` y `flags: 4` neutralizan menciones y
 * previews. El adjunto es `renderTextoPlano(orden)`, igual a la parte de
 * texto del mail.
 */
import type { OrdenParaEntrega } from "../order-model.js";
import { formatoFechaHora, formatoPesos, renderTextoPlano, textoProductos } from "../render/text.js";

export const MAX_CONTENT = 1900;
export const USERNAME = "RenovArte órdenes";

export interface DiscordPayload {
  content: string;
  username: string;
  allowed_mentions: { parse: never[] };
  flags: 4;
  attachments: [{ id: 0; filename: string }];
}

export interface DiscordRenderizado {
  payload: DiscordPayload;
  adjunto: { filename: string; contenido: string };
}

/** Cada backtick del texto -> U+02CB, para que no cierre el bloque. */
export function sinBackticks(s: string): string {
  return s.replace(/`/g, "ˋ");
}

export function renderDiscord(orden: OrdenParaEntrega): DiscordRenderizado {
  const n = orden.lineas.length;
  const cabecera =
    `Nueva orden ${orden.numero_orden} · ${formatoPesos(orden.total)} · ${textoProductos(n)}\n` +
    `${formatoFechaHora(orden.recibida_en)} (hora de Argentina)\n`;
  const contacto = [
    `Nombre: ${sinBackticks(orden.contacto.nombre)}`,
    `Teléfono: ${sinBackticks(orden.contacto.telefono)}`,
  ];
  const lineas = orden.lineas.map(
    (l) => `- ${sinBackticks(l.nombre)} (${sinBackticks(l.presentacion)}) x ${l.cantidad} · ${formatoPesos(l.subtotal)}`,
  );

  const armar = (k: number): string => {
    const cuerpo = [...contacto, "", "Productos:", ...lineas.slice(0, k)];
    if (k < n) cuerpo.push(`… y ${n - k} ${n - k === 1 ? "producto" : "productos"} más: ver el adjunto`);
    cuerpo.push("", `Total: ${formatoPesos(orden.total)}`);
    return `${cabecera}\`\`\`\n${cuerpo.join("\n")}\n\`\`\``;
  };

  // Mayor cantidad de lineas que entra; el total siempre queda visible.
  let k = n;
  while (k > 0 && armar(k).length > MAX_CONTENT) k--;
  const content = armar(k);

  const filename = `orden-${orden.numero_orden}.txt`;
  return {
    payload: {
      content,
      username: USERNAME,
      allowed_mentions: { parse: [] },
      flags: 4,
      attachments: [{ id: 0, filename }],
    },
    adjunto: { filename, contenido: renderTextoPlano(orden) },
  };
}
