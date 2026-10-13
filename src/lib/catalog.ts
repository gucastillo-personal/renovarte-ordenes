/**
 * Catalogo publicado (B5; RFC rev. 4 4.1-4.2; AC-15, AC-16; ADR-0018).
 *
 * Descarga `CATALOG_PRODUCTS_URL` (el `products.json` publico), con cache en
 * memoria de 5 min, revalidacion condicional (`If-None-Match`/304) y
 * timeout de 3 s. Si la descarga falla (red, timeout, 5xx, JSON o fila
 * invalidos) se sigue sirviendo la ultima copia valida mientras tenga menos
 * de 24 h desde que se confirmo vigente; sin copia valida:
 * `catalogo_no_disponible`. Nunca se acepta una orden sin catalogo.
 *
 * Modulo inyectable: `fetch`, reloj y URL entran por parametro; la cache es
 * del objeto devuelto por `createCatalog` (por contenedor, sin globales).
 *
 * Allowlist (RFC 4.2): de cada fila solo se conservan `id`, `nombre`,
 * `presentacion` y `precio_venta`. Cualquier otra clave (costo, margen,
 * precio de lista LACA, ...) se descarta al parsear y no existe en memoria.
 * No se loguea nada aqui.
 */

export const CACHE_TTL_MS = 5 * 60 * 1000;
export const STALE_MAX_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 3000;

/** Unicos campos que el servicio lee del catalogo. */
export interface ProductoCatalogo {
  id: string;
  nombre: string;
  presentacion: string;
  precio_venta: number;
}

export type Catalogo = ReadonlyMap<string, ProductoCatalogo>;

export type ResultadoCatalogo =
  | { ok: true; catalogo: Catalogo }
  | { ok: false; codigo: "catalogo_no_disponible" };

/** Subconjunto de `fetch` que se usa; `globalThis.fetch` lo cumple. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{
  status: number;
  headers: { get(nombre: string): string | null };
  json(): Promise<unknown>;
}>;

export interface CatalogDeps {
  url: string;
  fetch: FetchLike;
  /** Reloj en ms epoch. */
  now: () => number;
  timeoutMs?: number;
}

export interface CatalogClient {
  /** Catalogo de la cache si tiene < 5 min; si no, revalida. */
  get(): Promise<ResultadoCatalogo>;
  /** Revalida ya (RFC 4.2: refetch ante discrepancia); sigue con ETag. */
  forceRefresh(): Promise<ResultadoCatalogo>;
}

// --- Guard (copia de `isProduct` de renovarte-catalogo, sin import cruzado) --

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Misma regla que `isProduct` de renovarte-catalogo/src/lib/types.ts: la
 * fila tiene que ser valida para el catalogo para que el servicio la crea.
 */
export function isProduct(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of ["id", "proveedor", "categoria", "nombre", "presentacion", "descripcion", "imagen"]) {
    if (typeof value[key] !== "string") return false;
  }
  const precio = value["precio_venta"];
  if (typeof precio !== "number" || !Number.isFinite(precio)) return false;
  if (typeof value["en_oferta"] !== "boolean") return false;
  const tags = value["tags"];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) return false;

  const regular = value["precio_regular"];
  const descuento = value["descuento_pct"];
  if ((regular !== undefined) !== (descuento !== undefined)) return false;
  if (regular !== undefined && descuento !== undefined) {
    if (typeof regular !== "number" || !Number.isFinite(regular)) return false;
    if (typeof descuento !== "number" || !Number.isInteger(descuento)) return false;
    if (descuento < 1 || descuento > 99) return false;
    if (regular <= precio) return false;
  }
  const cod = value["codCategoria"];
  if (cod !== undefined && (!Array.isArray(cod) || !cod.every((c) => typeof c === "string"))) {
    return false;
  }
  return true;
}

/**
 * Parsea el JSON ya decodificado a un mapa por `id`, aplicando la
 * allowlist. `null` si no es un array, si alguna fila no pasa el guard
 * (como `validateProducts` del catalogo: un archivo con una fila rota no es
 * confiable) o si hay `id` repetidos (precio ambiguo).
 */
export function parseCatalogo(raw: unknown): Catalogo | null {
  if (!Array.isArray(raw)) return null;
  const mapa = new Map<string, ProductoCatalogo>();
  for (const fila of raw as unknown[]) {
    if (!isProduct(fila)) return null;
    const f = fila as Record<string, unknown>;
    const id = f["id"] as string;
    if (mapa.has(id)) return null;
    mapa.set(id, {
      id,
      nombre: f["nombre"] as string,
      presentacion: f["presentacion"] as string,
      precio_venta: f["precio_venta"] as number,
    });
  }
  return mapa;
}

// --- Cliente con cache --------------------------------------------------------

interface Copia {
  catalogo: Catalogo;
  etag: string | null;
  /** Ultima vez que se confirmo vigente (200 valido o 304). */
  confirmadoEn: number;
}

type Descarga = { tipo: "nuevo"; catalogo: Catalogo; etag: string | null } | { tipo: "igual" } | { tipo: "falla" };

export function createCatalog(deps: CatalogDeps): CatalogClient {
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  let copia: Copia | null = null;
  let enCurso: Promise<ResultadoCatalogo> | null = null;

  async function descargar(etag: string | null): Promise<Descarga> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Tambien corta si el fetch ignora la senal.
    const vencido = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve("timeout");
      }, timeoutMs);
    });
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (etag !== null) headers["if-none-match"] = etag;
      const leer = (async (): Promise<Descarga> => {
        const res = await deps.fetch(deps.url, { headers, signal: ctrl.signal });
        if (res.status === 304) return etag !== null ? { tipo: "igual" } : { tipo: "falla" };
        if (res.status !== 200) return { tipo: "falla" };
        const catalogo = parseCatalogo(await res.json());
        if (catalogo === null) return { tipo: "falla" };
        return { tipo: "nuevo", catalogo, etag: res.headers.get("etag") };
      })();
      leer.catch(() => undefined); // evita rechazo no manejado si gana el timeout
      const r = await Promise.race([leer, vencido]);
      return r === "timeout" ? { tipo: "falla" } : r;
    } catch {
      return { tipo: "falla" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function revalidar(): Promise<ResultadoCatalogo> {
    const d = await descargar(copia?.etag ?? null);
    const ahora = deps.now();
    if (d.tipo === "nuevo") {
      copia = { catalogo: d.catalogo, etag: d.etag, confirmadoEn: ahora };
    } else if (d.tipo === "igual" && copia !== null) {
      copia = { ...copia, confirmadoEn: ahora };
    } else if (copia === null || ahora - copia.confirmadoEn >= STALE_MAX_MS) {
      return { ok: false, codigo: "catalogo_no_disponible" };
    }
    // Falla con copia < 24 h: se sigue sirviendo la copia (no se extiende).
    return copia === null
      ? { ok: false, codigo: "catalogo_no_disponible" }
      : { ok: true, catalogo: copia.catalogo };
  }

  function revalidarUnaVez(): Promise<ResultadoCatalogo> {
    enCurso ??= revalidar().finally(() => {
      enCurso = null;
    });
    return enCurso;
  }

  return {
    get() {
      if (copia !== null && deps.now() - copia.confirmadoEn < CACHE_TTL_MS) {
        return Promise.resolve({ ok: true, catalogo: copia.catalogo });
      }
      return revalidarUnaVez();
    },
    forceRefresh: revalidarUnaVez,
  };
}
