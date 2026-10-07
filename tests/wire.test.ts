import { describe, expect, it } from "vitest";
import type {
  CampoOrden,
  CrearOrdenRequest,
  CrearOrdenResponse,
  EstadoResponse,
} from "../src/wire.js";

// Fixtures con valores ficticios obviamente falsos (repo público, ADR-0020).
// `satisfies` verifica la forma en compilación (`pnpm typecheck`); los
// expect verifican el discriminante y que el JSON round-trip no cambia.

const estado = {
  disponible: { v: 1, resultado: "disponible", form_token: "token-ficticio" },
  tope: { v: 1, resultado: "tope_alcanzado" },
  noDisponible: { v: 1, resultado: "no_disponible" },
} satisfies Record<string, EstadoResponse>;

const request = {
  v: 1,
  idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  form_token: "token-ficticio",
  lineas: [{ producto_id: "P-0001", cantidad: 2, precio_visto: 1000 }],
  total_visto: 2000,
  contacto: { nombre: "Persona Ficticia", telefono: "0000000000" },
  sitio_web: "",
} satisfies CrearOrdenRequest;

const respuestas = {
  aceptada: {
    v: 1,
    resultado: "aceptada",
    numero_orden: "ORD-TEST-0001",
    recibida_en: "2000-01-01T00:00:00.000Z",
  },
  rechazada: {
    v: 1,
    resultado: "rechazada_por_catalogo",
    lineas: [
      { producto_id: "P-0001", estado: "precio_cambiado", precio_vigente: 1100 },
      { producto_id: "P-0002", estado: "no_disponible" },
    ],
    total_vigente: 2200,
  },
  invalida: {
    v: 1,
    resultado: "invalida",
    errores: [
      { campo: "contacto.nombre", codigo: "formato" },
      { campo: "form_token", codigo: "token_vencido" },
      { campo: null, codigo: "no_permitido" },
    ],
  },
  invalidaGeneral: { v: 1, resultado: "invalida", errores: [] },
  tope: { v: 1, resultado: "tope_alcanzado" },
  falla: { v: 1, resultado: "falla", codigo: "envio_fallido" },
} satisfies Record<string, CrearOrdenResponse>;

const roundTrip = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe("wire: EstadoResponse", () => {
  it("cada variante tiene v:1 y su discriminante", () => {
    expect(Object.values(estado).map((e) => e.resultado)).toEqual([
      "disponible",
      "tope_alcanzado",
      "no_disponible",
    ]);
    for (const e of Object.values(estado)) {
      expect(roundTrip(e)).toEqual(e);
      expect(e.v).toBe(1);
    }
  });

  it("solo 'disponible' lleva form_token", () => {
    expect(estado.disponible.form_token).toBeTypeOf("string");
    expect("form_token" in estado.tope).toBe(false);
    expect("form_token" in estado.noDisponible).toBe(false);
  });
});

describe("wire: CrearOrdenRequest", () => {
  it("contacto es exactamente { nombre, telefono }", () => {
    expect(Object.keys(request.contacto).sort()).toEqual(["nombre", "telefono"]);
  });

  it("no lleva claves retiradas ni de entrega", () => {
    const keys = Object.keys(request);
    for (const k of ["email", "direccion", "localidad", "to", "cc", "bcc", "webhook", "canal"]) {
      expect(keys).not.toContain(k);
    }
    expect(roundTrip(request)).toEqual(request);
  });
});

describe("wire: CrearOrdenResponse", () => {
  it("cada variante tiene v:1 y un resultado distinto del contrato", () => {
    const resultados = Object.values(respuestas).map((r) => r.resultado);
    expect(new Set(resultados)).toEqual(
      new Set(["aceptada", "rechazada_por_catalogo", "invalida", "tope_alcanzado", "falla"]),
    );
    for (const r of Object.values(respuestas)) {
      expect(roundTrip(r)).toEqual(r);
      expect(r.v).toBe(1);
    }
  });

  it("CampoOrden incluye contacto.nombre", () => {
    const campos: CampoOrden[] = [
      "contacto.nombre",
      "contacto.telefono",
      "lineas",
      "total_visto",
      "form_token",
    ];
    expect(campos).toContain("contacto.nombre");
  });

  it("ningún fixture menciona Discord ni canales de entrega", () => {
    const todo = JSON.stringify([estado, request, respuestas]).toLowerCase();
    expect(todo).not.toContain("discord");
    expect(todo).not.toContain("webhook");
  });
});
