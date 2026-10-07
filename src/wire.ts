/**
 * Contrato HTTP con renovarte-catalogo (RFC rev. 4 §3, spec 0017, ADR-0020).
 *
 * Solo tipos: la validación en runtime vive en `validate-order.ts` (B4).
 * `frontend-agent` copia este archivo tal cual (F2); cualquier cambio es un
 * cambio de contrato (L2) y toca a productor y consumidor.
 *
 * Todas las respuestas son JSON con `v: 1` y un discriminante `resultado`.
 * El cliente decide por `resultado`, nunca por el texto. Si el body no
 * parsea o no trae un `resultado` conocido, es falla genérica.
 *
 * El visitante no se entera de cuántos canales de entrega hay: el contrato
 * no expone ningún detalle de los canales.
 */

// ---------------------------------------------------------------------------
// GET /v1/estado — disponibilidad + token de formulario (§3.1)
// ---------------------------------------------------------------------------

/** 200 */
export type EstadoResponse =
  | { v: 1; resultado: "disponible"; form_token: string }
  | { v: 1; resultado: "tope_alcanzado" }
  // corte manual o por flood → el cliente lo trata como falla genérica
  | { v: 1; resultado: "no_disponible" };

// ---------------------------------------------------------------------------
// POST /v1/ordenes — crear la orden (§3.2)
// ---------------------------------------------------------------------------

/**
 * `Content-Type: application/json`, body de 16 KB como máximo.
 * Esquema estricto: cualquier clave no listada hace que la orden se rechace
 * como `invalida`/`no_permitido` (AC-17), incluido cualquier intento de
 * `to`, `cc`, `bcc`, `destinatario`, `reply_to`, `webhook`, `canal`, y las
 * claves retiradas `email`, `direccion` y `localidad`.
 */
export interface CrearOrdenRequest {
  v: 1;
  /** UUID v4 generado por el cliente (reglas en RFC §5.1). */
  idempotency_key: string;
  /** De GET /v1/estado (RFC §6.2). */
  form_token: string;
  /** 1..100 líneas (Q-F1), `producto_id` sin repetir. */
  lineas: Array<{
    /** `id` de products.json. */
    producto_id: string;
    /** Entero 1..20 (ux.md #D). */
    cantidad: number;
    /** Entero ARS: el `precio_venta` que el visitante tenía en pantalla. */
    precio_visto: number;
  }>;
  /** Entero ARS = Σ precio_visto × cantidad, lo que el visitante vio. */
  total_visto: number;
  /**
   * Únicos datos personales (ADR-0020, Ley 25.326): solo en memoria, nunca
   * a DynamoDB, logs, métricas, errores ni respuestas.
   */
  contacto: {
    /**
     * "Nombre y apellido", un solo campo; obligatorio. Tras recortar y
     * normalizar (NFC, colapso de espacios): 2..80 caracteres y ≥ 1 letra
     * (AC-9, RFC §3.2.1).
     */
    nombre: string;
    /** Obligatorio; 8..15 dígitos tras quitar espacios, - ( ) + (AC-9). */
    telefono: string;
  };
  /** Honeypot: debe venir ausente o vacío (RFC §6.2). */
  sitio_web?: "";
}

export type CampoOrden =
  | "contacto.nombre"
  | "contacto.telefono"
  | "lineas"
  | "total_visto"
  | "form_token";

export type CodigoError =
  | "requerido"
  | "formato"
  | "largo"
  | "token_vencido"
  | "no_permitido";

export type CodigoFalla =
  | "limite_frecuencia"
  | "envio_fallido"
  | "catalogo_no_disponible"
  | "en_proceso"
  | "estado_incierto"
  | "origen"
  | "mantenimiento"
  | "interno";

export type CrearOrdenResponse =
  // 201 (primera vez) o 200 (reintento idempotente de la misma orden).
  // Significa: al menos un canal de entrega confirmó la orden (RFC §5.3).
  | {
      v: 1;
      resultado: "aceptada";
      numero_orden: string;
      /** ISO-8601 UTC. */
      recibida_en: string;
    }
  // 409: no se entregó nada por ningún canal. El cliente actualiza las
  // líneas y pide reenviar.
  | {
      v: 1;
      resultado: "rechazada_por_catalogo";
      /** Solo las líneas con problema. */
      lineas: Array<
        | { producto_id: string; estado: "precio_cambiado"; precio_vigente: number }
        | { producto_id: string; estado: "no_disponible" }
      >;
      /** Σ precio_vigente × cantidad sobre las líneas disponibles. */
      total_vigente: number;
    }
  // 422: datos que el servidor rechaza (AC-9, defensa en profundidad).
  // errores: [] → el cliente muestra el error general arriba del formulario.
  // token_vencido = token fuera de su ventana de validez (vencido o de < 3 s,
  // RFC §6.2). Los errores llevan solo `campo` y `codigo`, jamás el valor.
  | {
      v: 1;
      resultado: "invalida";
      errores: Array<{ campo: CampoOrden | null; codigo: CodigoError }>;
    }
  // 503: tope mensual (AC-22). Sin "Reintentar" en la UI.
  | { v: 1; resultado: "tope_alcanzado" }
  // 429 / 403 / 500 / 502 / 503: falla genérica reintentable (AC-20).
  | { v: 1; resultado: "falla"; codigo: CodigoFalla };
