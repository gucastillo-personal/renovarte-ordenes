/**
 * Auditoria de fugas (B17; RFC rev. 4 6.4; AC-16, AC-17, AC-26; ADR-0006).
 *
 * Este repo es PUBLICO. `pnpm check:leak` (scripts/check-leak.ts) aplica:
 *   1. Patrones de secretos/identificadores en CUALQUIER archivo versionable:
 *      URL de webhook de Discord, ARN con ID de cuenta, numeros de 12 digitos,
 *      IDs de Discord, claves de AWS, claves privadas y tokens de GitHub/Slack.
 *   2. Nombres de archivo que nunca deben versionarse (`*.tfvars`,
 *      `*.tfstate*`, `.env*`, claves).
 *   3. En `src/`: tokens de costo, margen o precio de lista LACA (sin
 *      comentarios) y emails literales distintos del placeholder.
 *   4. Salidas renderizadas de ejemplo (mail, mensaje de Discord con su
 *      adjunto, JSON del contrato) construidas desde un catalogo CON claves
 *      sensibles: no puede aparecer ninguna en la salida.
 *
 * Los hallazgos nombran regla y lugar; NUNCA imprimen el valor. Este archivo
 * define los patrones, asi que el CLI lo excluye del escaneo de tokens y de
 * patrones. Funciones puras: el CLI hace la E/S.
 */
import { renderDiscord } from "./lib/discord/render.js";
import { parseCatalogo } from "./lib/catalog.js";
import { renderMail } from "./lib/mail/render.js";
import { construirOrdenParaEntrega } from "./lib/order-model.js";
import type { CrearOrdenResponse, EstadoResponse } from "./wire.js";

export interface Hallazgo {
  /** `ruta:linea` o nombre de la salida de ejemplo. */
  donde: string;
  regla: string;
}

interface Regla {
  nombre: string;
  re: RegExp;
}

/** Placeholder del destinatario: el unico email literal permitido en `src/`. */
export const EMAIL_PLACEHOLDER = "destinatario@example.invalid";

/** Patrones sobre cualquier archivo de texto versionable. */
export const REGLAS_GLOBALES: readonly Regla[] = [
  { nombre: "webhook de Discord", re: /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\S/i },
  { nombre: "ARN con ID de cuenta", re: /arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:/i },
  { nombre: "numero de 12 digitos (¿ID de cuenta AWS?)", re: /(?<![\d.])\d{12}(?![\d.])/ },
  { nombre: "ID de Discord (17-20 digitos)", re: /(?<![\d.])\d{17,20}(?![\d.])/ },
  { nombre: "access key id de AWS", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { nombre: "secret access key de AWS", re: /aws_secret_access_key\s*[=:]\s*\S{20,}/i },
  { nombre: "session token de AWS", re: /aws_session_token\s*[=:]\s*\S{20,}/i },
  { nombre: "clave privada (PEM)", re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { nombre: "token de GitHub", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { nombre: "token de Slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
];

/** Tokens de costo/margen/precio LACA en el codigo de `src/` (sin comentarios). */
export const TOKENS_SRC: readonly Regla[] = [
  { nombre: "token de costo/margen/LACA en src/", re: /precio_?costo|precio_?lista|precio_?laca|lista_?laca|\bmargen\b|\bmarkup\b|\blaca\b/i },
];

/** Tokens en una salida renderizada: aqui no puede aparecer ni la palabra. */
export const TOKENS_SALIDA: readonly Regla[] = [
  { nombre: "token de costo/margen/LACA en una salida", re: /precio_?costo|precio_?lista|precio de lista|\bcostos?\b|\bmargen\b|\bmarkup\b|\blaca\b/i },
];

const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Nombres que nunca se versionan. */
const NOMBRES_PROHIBIDOS: readonly Regla[] = [
  { nombre: "archivo *.tfvars versionado", re: /\.tfvars$/ },
  { nombre: "archivo *.tfstate versionado", re: /\.tfstate(?:\.[^/]*)?$/ },
  { nombre: "archivo .env versionado", re: /(?:^|\/)\.env(?:\.(?!example$)[^/]*)?$/ },
  { nombre: "clave privada versionada", re: /\.(?:pem|p12|pfx)$/ },
];

/** Quita comentarios `/* *\/` y `//` (conserva los saltos de linea). */
export function sinComentarios(codigo: string): string {
  const sinBloques = codigo.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return sinBloques
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const lineas = (texto: string): string[] => texto.split("\n");

/** Reglas por nombre de archivo (`ruta` relativa, con `/`). */
export function auditarNombres(rutas: readonly string[]): Hallazgo[] {
  const out: Hallazgo[] = [];
  for (const r of rutas) for (const { nombre, re } of NOMBRES_PROHIBIDOS) if (re.test(r)) out.push({ donde: r, regla: nombre });
  return out;
}

/** Reglas por contenido de un archivo; las de `src/` solo si `ruta` empieza con `src/`. */
export function auditarContenido(ruta: string, contenido: string): Hallazgo[] {
  const out: Hallazgo[] = [];
  lineas(contenido).forEach((l, i) => {
    for (const { nombre, re } of REGLAS_GLOBALES) if (re.test(l)) out.push({ donde: `${ruta}:${i + 1}`, regla: nombre });
  });
  if (ruta.startsWith("src/") && /\.(?:ts|mjs|js)$/.test(ruta)) {
    lineas(sinComentarios(contenido)).forEach((l, i) => {
      for (const { nombre, re } of TOKENS_SRC) if (re.test(l)) out.push({ donde: `${ruta}:${i + 1}`, regla: nombre });
    });
    // Los emails se buscan en el texto completo: tambien en comentarios y strings.
    lineas(contenido).forEach((l, i) => {
      for (const m of l.matchAll(RE_EMAIL)) {
        if (m[0] !== EMAIL_PLACEHOLDER) out.push({ donde: `${ruta}:${i + 1}`, regla: "email literal en src/" });
      }
    });
  }
  return out;
}

/** Reglas sobre una salida renderizada de ejemplo. */
export function auditarSalida(nombre: string, texto: string): Hallazgo[] {
  const out: Hallazgo[] = [];
  for (const { nombre: regla, re } of [...TOKENS_SALIDA, ...REGLAS_GLOBALES]) if (re.test(texto)) out.push({ donde: nombre, regla });
  return out;
}

// --- Salidas de ejemplo ------------------------------------------------------------

/** Catalogo de ejemplo CON claves sensibles: el parseo debe descartarlas. */
const FILA_CON_CLAVES_SENSIBLES = {
  id: "EJ-1",
  proveedor: "PROV",
  categoria: "Cat",
  nombre: "Producto de ejemplo",
  presentacion: "500 g",
  descripcion: "d",
  imagen: "/i.png",
  precio_venta: 20000,
  en_oferta: false,
  tags: [],
  precio_costo: 111,
  margen: 0.3,
  precio_lista_laca: 222,
};

const RESPUESTAS_EJEMPLO: ReadonlyArray<CrearOrdenResponse | EstadoResponse> = [
  { v: 1, resultado: "disponible", form_token: "token-de-ejemplo" },
  { v: 1, resultado: "tope_alcanzado" },
  { v: 1, resultado: "no_disponible" },
  { v: 1, resultado: "aceptada", numero_orden: "RA-00000", recibida_en: "2026-10-13T17:05:00.000Z" },
  {
    v: 1,
    resultado: "rechazada_por_catalogo",
    lineas: [
      { producto_id: "EJ-1", estado: "precio_cambiado", precio_vigente: 20000 },
      { producto_id: "EJ-2", estado: "no_disponible" },
    ],
    total_vigente: 20000,
  },
  { v: 1, resultado: "invalida", errores: [{ campo: "contacto.nombre", codigo: "requerido" }] },
  { v: 1, resultado: "falla", codigo: "interno" },
];

/** Mail, mensaje de Discord (con adjunto) y JSON del contrato, renderizados con datos ficticios. */
export function ejemplosDeSalida(): Array<{ nombre: string; texto: string }> {
  const catalogo = parseCatalogo([FILA_CON_CLAVES_SENSIBLES]);
  if (catalogo === null) throw new Error("catalogo de ejemplo invalido");
  const r = construirOrdenParaEntrega({
    numero_orden: "RA-00000",
    ahoraMs: Date.UTC(2026, 9, 13, 17, 5, 0),
    contacto: { nombre: "Persona de Ejemplo", telefono: "11 5550 0000" },
    lineas: [{ producto_id: "EJ-1", cantidad: 2 }],
    catalogo,
  });
  if (!r.ok) throw new Error("orden de ejemplo invalida");
  const mail = renderMail(r.orden);
  const discord = renderDiscord(r.orden);
  return [
    { nombre: "ejemplo:mail", texto: [mail.asunto, mail.texto, mail.html].join("\n") },
    {
      nombre: "ejemplo:discord",
      texto: [JSON.stringify(discord.payload), discord.adjunto.filename, discord.adjunto.contenido].join("\n"),
    },
    ...RESPUESTAS_EJEMPLO.map((j, i) => ({ nombre: `ejemplo:json-${i + 1}`, texto: JSON.stringify(j) })),
  ];
}

export function auditarEjemplos(): Hallazgo[] {
  return ejemplosDeSalida().flatMap((e) => auditarSalida(e.nombre, e.texto));
}
