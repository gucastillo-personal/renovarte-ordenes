import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  validarNombre,
  validarTelefono,
  validateOrder,
  validateRawBody,
  type ErrorOrden,
  type ResultadoValidacion,
} from "../src/lib/validate-order.js";
import { NOMBRE_VECTORES } from "./fixtures/nombre-vectores.js";

// Valores ficticios obviamente falsos (repo publico, ADR-0020).
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  idempotency_key: UUID,
  form_token: "token-ficticio",
  lineas: [{ producto_id: "P-0001", cantidad: 2, precio_visto: 1000 }],
  total_visto: 2000,
  contacto: { nombre: "Persona Ficticia", telefono: "0000 0000 00" },
  ...over,
});

const sin = (clave: string): Record<string, unknown> => {
  const o = base();
  delete o[clave];
  return o;
};

const conContacto = (c: Record<string, unknown>) =>
  base({ contacto: { nombre: "Persona Ficticia", telefono: "00000000", ...c } });

const errores = (r: ResultadoValidacion): ErrorOrden[] => {
  if (r.ok || r.motivo !== "invalida") throw new Error("se esperaba invalida");
  return r.errores;
};

describe("orden valida", () => {
  it("acepta el caso base y devuelve el nombre normalizado", () => {
    const r = validateOrder(
      base({ contacto: { nombre: "  Ana   Ficticia ", telefono: "0000 0000 00" }, sitio_web: "" }),
    );
    expect(r).toEqual({
      ok: true,
      orden: {
        v: 1,
        idempotency_key: UUID,
        form_token: "token-ficticio",
        lineas: [{ producto_id: "P-0001", cantidad: 2, precio_visto: 1000 }],
        total_visto: 2000,
        contacto: { nombre: "Ana Ficticia", telefono: "0000 0000 00" },
      },
    });
  });

  it("no hace falta sitio_web", () => {
    expect(validateOrder(base()).ok).toBe(true);
  });
});

describe("nombre: vectores compartidos (AC-9)", () => {
  it.each(NOMBRE_VECTORES.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const r = validarNombre(v.entrada);
    if (v.esperado.ok) expect(r).toEqual({ ok: true, nombre: v.esperado.normalizado });
    else expect(r).toEqual({ ok: false, codigo: v.esperado.codigo });
  });

  it("mismo veredicto a traves de validateOrder, con campo contacto.nombre", () => {
    for (const v of NOMBRE_VECTORES) {
      const contacto: Record<string, unknown> = { telefono: "00000000" };
      if (v.entrada !== undefined) contacto["nombre"] = v.entrada;
      const r = validateOrder(base({ contacto }));
      if (v.esperado.ok) {
        expect(r.ok, v.id).toBe(true);
        if (r.ok) expect(r.orden.contacto.nombre).toBe(v.esperado.normalizado);
      } else {
        expect(errores(r), v.id).toEqual([{ campo: "contacto.nombre", codigo: v.esperado.codigo }]);
      }
    }
  });

  it("el nombre se mide en puntos de codigo, no en unidades UTF-16", () => {
    const astral = "\u{20BB7}"; // letra (Lo) fuera del BMP
    expect(validarNombre(astral.repeat(80)).ok).toBe(true);
    expect(validarNombre(astral.repeat(81))).toEqual({ ok: false, codigo: "largo" });
  });

  it("clave contacto.nombre ausente y contacto ausente -> requerido", () => {
    expect(errores(validateOrder(base({ contacto: { telefono: "00000000" } })))).toEqual([
      { campo: "contacto.nombre", codigo: "requerido" },
    ]);
    expect(errores(validateOrder(sin("contacto")))).toEqual([
      { campo: "contacto.nombre", codigo: "requerido" },
      { campo: "contacto.telefono", codigo: "requerido" },
    ]);
  });

  it("contacto que no es objeto -> formato en ambos campos", () => {
    expect(errores(validateOrder(base({ contacto: "x" })))).toEqual([
      { campo: "contacto.nombre", codigo: "formato" },
      { campo: "contacto.telefono", codigo: "formato" },
    ]);
  });
});

describe("telefono (AC-9)", () => {
  it.each([
    ["8 digitos", "00000000"],
    ["15 digitos", "000000000000000"],
    ["separadores validos", "+00 (000) 000-0000"],
    ["espacios alrededor", "  00000000  "],
    ["NBSP como espacio", "0000\u00a00000"],
  ])("ok: %s", (_n, tel) => {
    expect(validarTelefono(tel).ok).toBe(true);
  });

  it.each([
    ["vacio", "", "requerido"],
    ["solo espacios", "   ", "requerido"],
    ["7 digitos", "0000000", "formato"],
    ["16 digitos", "0000000000000000", "formato"],
    ["letras", "0000abcd0000", "formato"],
    ["digitos no ASCII", "\u0660\u0660\u0660\u0660\u0660\u0660\u0660\u0660", "formato"],
    ["LF", "0000\n0000", "formato"],
    ["CR", "0000\r0000", "formato"],
    ["tab", "0000\t0000", "formato"],
    ["Cc (NUL)", "0000\u00000000", "formato"],
    ["bidi 202A", "0000‪0000", "formato"],
    ["bidi 2069", "0000⁩0000", "formato"],
    ["U+2028", "0000 0000", "formato"],
    ["no string", 12345678, "formato"],
    ["null", null, "formato"],
  ])("error: %s", (_n, tel, codigo) => {
    expect(validarTelefono(tel)).toEqual({ ok: false, codigo });
  });

  it("ausente -> requerido, con campo contacto.telefono", () => {
    expect(errores(validateOrder(base({ contacto: { nombre: "Persona Ficticia" } })))).toEqual([
      { campo: "contacto.telefono", codigo: "requerido" },
    ]);
  });
});

describe("esquema estricto (AC-17)", () => {
  it.each([
    "to",
    "cc",
    "bcc",
    "destinatario",
    "reply_to",
    "webhook",
    "canal",
    "email",
    "direccion",
    "localidad",
    "__proto__",
  ])("clave de primer nivel %s -> no_permitido", (k) => {
    // JSON.parse crea `__proto__` como clave propia, como lo haria un body real.
    const body = JSON.parse(JSON.stringify(base()).replace(/^\{/, `{${JSON.stringify(k)}:"x",`)) as unknown;
    expect(errores(validateOrder(body))).toEqual([{ campo: null, codigo: "no_permitido" }]);
  });

  it.each(["email", "direccion", "localidad", "nombre_completo"])("contacto.%s -> no_permitido", (k) => {
    expect(errores(validateOrder(conContacto({ [k]: "x" })))).toEqual([{ campo: null, codigo: "no_permitido" }]);
  });

  it("clave extra dentro de una linea (p. ej. nombre o precio de lista) -> no_permitido", () => {
    const r = validateOrder(base({ lineas: [{ producto_id: "P-1", cantidad: 1, precio_visto: 1, nombre: "x" }] }));
    expect(errores(r)).toEqual([{ campo: null, codigo: "no_permitido" }]);
  });

  it("body que no es objeto -> formato", () => {
    for (const x of [null, [], "x", 1, undefined]) {
      expect(errores(validateOrder(x))).toEqual([{ campo: null, codigo: "formato" }]);
    }
  });

  it("v distinto de 1 e idempotency_key que no es UUID v4 -> formato", () => {
    expect(errores(validateOrder(base({ v: 2 })))).toEqual([{ campo: null, codigo: "formato" }]);
    expect(errores(validateOrder(base({ idempotency_key: "no-es-uuid" })))).toEqual([
      { campo: null, codigo: "formato" },
    ]);
    expect(errores(validateOrder(base({ idempotency_key: 7 })))).toEqual([{ campo: null, codigo: "formato" }]);
  });

  it("form_token ausente -> requerido; vacio, no string o con control -> formato", () => {
    expect(errores(validateOrder(sin("form_token")))).toEqual([{ campo: "form_token", codigo: "requerido" }]);
    for (const t of ["", 5, "a\nb", "a".repeat(513)]) {
      expect(errores(validateOrder(base({ form_token: t })))).toEqual([{ campo: "form_token", codigo: "formato" }]);
    }
  });
});

describe("honeypot sitio_web", () => {
  it("vacio o ausente pasa", () => {
    expect(validateOrder(base({ sitio_web: "" })).ok).toBe(true);
  });

  it.each(["x", " ", "http://ejemplo.invalid", 0, null, false, {}])("con contenido (%j) -> errores: []", (v) => {
    expect(errores(validateOrder(base({ sitio_web: v })))).toEqual([]);
  });

  it("gana sobre otros errores: sin pista del motivo", () => {
    expect(errores(validateOrder(base({ sitio_web: "x", total_visto: -1, to: "x" })))).toEqual([]);
  });
});

describe("lineas", () => {
  const linea = (i: number, over: Record<string, unknown> = {}) => ({
    producto_id: `P-${i}`,
    cantidad: 1,
    precio_visto: 10,
    ...over,
  });
  const lin = (lineas: unknown) => base({ lineas });
  const formato = [{ campo: "lineas", codigo: "formato" }];

  it("1 y 100 lineas pasan; 101 -> largo; vacio y ausente -> requerido", () => {
    expect(validateOrder(lin([linea(1)])).ok).toBe(true);
    expect(validateOrder(lin(Array.from({ length: 100 }, (_, i) => linea(i)))).ok).toBe(true);
    expect(errores(validateOrder(lin(Array.from({ length: 101 }, (_, i) => linea(i)))))).toEqual([
      { campo: "lineas", codigo: "largo" },
    ]);
    expect(errores(validateOrder(lin([])))).toEqual([{ campo: "lineas", codigo: "requerido" }]);
    expect(errores(validateOrder(sin("lineas")))).toEqual([{ campo: "lineas", codigo: "requerido" }]);
  });

  it("no arreglo y elementos que no son objeto -> formato", () => {
    expect(errores(validateOrder(lin("x")))).toEqual(formato);
    expect(errores(validateOrder(lin([null, 1])))).toEqual(formato);
  });

  it("producto_id repetido -> formato", () => {
    expect(errores(validateOrder(lin([linea(1), linea(1, { cantidad: 2 })])))).toEqual(formato);
  });

  it.each([
    ["vacio", ""],
    ["no string", 5],
    ["con LF", "P\n1"],
    ["65 caracteres", "p".repeat(65)],
    ["ausente", undefined],
  ])("producto_id %s -> formato", (_n, id) => {
    expect(errores(validateOrder(lin([linea(1, { producto_id: id })])))).toEqual(formato);
  });

  it.each([
    ["1", 1, true],
    ["20", 20, true],
    ["0", 0, false],
    ["21", 21, false],
    ["-1", -1, false],
    ["1,5", 1.5, false],
    ["NaN", NaN, false],
    ["Infinity", Infinity, false],
    ["string", "2", false],
    ["null", null, false],
  ])("cantidad %s", (_n, c, ok) => {
    const r = validateOrder(lin([linea(1, { cantidad: c })]));
    if (ok) expect(r.ok).toBe(true);
    else expect(errores(r)).toEqual(formato);
  });

  it.each([
    ["0", 0, true],
    ["10", 10, true],
    ["-1", -1, false],
    ["1,5", 1.5, false],
    ["string", "10", false],
    ["2^53", 2 ** 53, false],
    ["NaN", NaN, false],
  ])("precio_visto %s", (_n, p, ok) => {
    const r = validateOrder(lin([linea(1, { precio_visto: p })]));
    if (ok) expect(r.ok).toBe(true);
    else expect(errores(r)).toEqual(formato);
  });

  it("precio_visto o cantidad ausentes -> formato", () => {
    expect(errores(validateOrder(lin([{ producto_id: "P-1", cantidad: 1 }])))).toEqual(formato);
    expect(errores(validateOrder(lin([{ producto_id: "P-1", precio_visto: 1 }])))).toEqual(formato);
  });
});

describe("total_visto", () => {
  it.each([
    ["0", 0, true],
    ["entero", 123456, true],
    ["negativo", -1, false],
    ["decimal", 10.5, false],
    ["string", "10", false],
    ["NaN", NaN, false],
  ])("%s", (_n, t, ok) => {
    const r = validateOrder(base({ total_visto: t }));
    if (ok) expect(r.ok).toBe(true);
    else expect(errores(r)).toEqual([{ campo: "total_visto", codigo: "formato" }]);
  });

  it("ausente -> requerido", () => {
    expect(errores(validateOrder(sin("total_visto")))).toEqual([{ campo: "total_visto", codigo: "requerido" }]);
  });
});

describe("tamano y JSON (validateRawBody)", () => {
  const padded = (bytes: number) => {
    const vacio = JSON.stringify({ ...base(), form_token: "" }).length;
    return JSON.stringify({ ...base(), form_token: "t".repeat(bytes - vacio) });
  };

  it("un body de exactamente 16 KB entra al esquema; 1 byte mas -> demasiado_grande", () => {
    const justo = padded(MAX_BODY_BYTES);
    expect(Buffer.byteLength(justo)).toBe(MAX_BODY_BYTES);
    // pasa el tope y llega al esquema (el token de > 512 caracteres es invalido)
    expect(validateRawBody(justo)).toMatchObject({ ok: false, motivo: "invalida" });
    expect(validateRawBody(padded(MAX_BODY_BYTES + 1))).toEqual({ ok: false, motivo: "demasiado_grande" });
  });

  it("mide bytes, no caracteres, y acepta Uint8Array", () => {
    const multibyte = JSON.stringify({ x: "é".repeat(MAX_BODY_BYTES / 2) }); // 2 bytes c/u
    expect(multibyte.length).toBeLessThan(MAX_BODY_BYTES);
    expect(validateRawBody(multibyte)).toEqual({ ok: false, motivo: "demasiado_grande" });
    expect(validateRawBody(Buffer.from(JSON.stringify(base())))).toMatchObject({ ok: true });
  });

  it("JSON invalido -> json_invalido", () => {
    expect(validateRawBody("{no es json")).toEqual({ ok: false, motivo: "json_invalido" });
    expect(validateRawBody("")).toEqual({ ok: false, motivo: "json_invalido" });
  });

  it("100 lineas caben bajo el tope", () => {
    const lineas = Array.from({ length: 100 }, (_, i) => ({
      producto_id: `P-${String(i).padStart(7, "0")}`,
      cantidad: 20,
      precio_visto: 999999,
    }));
    const raw = JSON.stringify(base({ lineas }));
    expect(Buffer.byteLength(raw)).toBeLessThan(MAX_BODY_BYTES);
    expect(validateRawBody(raw).ok).toBe(true);
  });
});

describe("privacidad (ADR-0020): los errores nunca llevan el valor", () => {
  it("ni nombre ni telefono ni ids aparecen en los errores", () => {
    const r = validateOrder({
      v: 1,
      idempotency_key: "key-ficticia",
      form_token: "TKN-ficticio\n",
      lineas: [{ producto_id: "ID-ficticio\n", cantidad: 0, precio_visto: -1 }],
      total_visto: "x",
      contacto: { nombre: "ZZ-nombre-ficticio‮", telefono: "TEL-ficticio-abc", extra: "valor-ficticio" },
    });
    const json = JSON.stringify(r);
    for (const s of ["ZZ-nombre", "TEL-ficticio", "ID-ficticio", "key-ficticia", "valor-ficticio", "TKN-ficticio"]) {
      expect(json).not.toContain(s);
    }
    for (const e of errores(r)) expect(Object.keys(e).sort()).toEqual(["campo", "codigo"]);
  });
});
