import { describe, expect, it } from "vitest";
import {
  AHORA0,
  DESTINATARIO,
  IP,
  MARCA_BODY_DISCORD,
  NOMBRE_CANARIO,
  ORIGEN,
  SECRETO,
  T0,
  TELEFONO_CANARIO,
  URL_WEBHOOK,
  crearArnes,
  json,
  type Arnes,
} from "./fixtures/http-harness.js";
import { verificarToken } from "../src/lib/form-token.js";

const canales = (h: Arnes): number => h.mailInputs.length + h.discordLlamadas.length;
const sinEscrituras = (h: Arnes): void => expect(h.writes).toEqual([]);

/** Todo lo que el servicio escribio o logueo, para buscar datos que no deben estar. */
function huella(h: Arnes, respuestas: string[] = []): string {
  return [...h.logs, ...h.writes.map((w) => w.data), ...respuestas].join("\n");
}
function sinDatosPersonales(h: Arnes, respuestas: string[] = []): void {
  const todo = huella(h, respuestas);
  const prohibidos = [
    NOMBRE_CANARIO,
    NOMBRE_CANARIO.normalize("NFD"),
    "Zoilo",
    "Canar",
    TELEFONO_CANARIO,
    "5550-1234",
    "5491155501234",
    "11 5550",
    IP,
    URL_WEBHOOK,
    URL_WEBHOOK.split("/").pop()!,
    MARCA_BODY_DISCORD,
  ];
  for (const p of prohibidos) expect(todo, `aparece "${p.slice(0, 8)}..."`).not.toContain(p);
}

describe("GET /v1/estado", () => {
  it("disponible: token valido que cumple la ventana 3 s - 2 h; sin escrituras ni canales", async () => {
    const h = crearArnes();
    const r = await h.get();
    expect(r.statusCode).toBe(200);
    const b = json(r);
    expect(b).toMatchObject({ v: 1, resultado: "disponible" });
    expect(verificarToken(b["form_token"], SECRETO, AHORA0 + 3000).ok).toBe(true);
    expect(verificarToken(b["form_token"], SECRETO, AHORA0 + 2000).ok).toBe(false);
    sinEscrituras(h);
    expect(canales(h)).toBe(0);
  });

  it.each([
    ["tope_alcanzado", "tope_alcanzado"],
    ["presupuesto", "tope_alcanzado"],
    ["flood", "no_disponible"],
    ["manual", "no_disponible"],
    ["desconocido", "no_disponible"],
    ["algo-raro", "no_disponible"],
  ])("flag apagado (%s) -> %s, sin escrituras ni token", async (motivo, esperado) => {
    const h = crearArnes({ controlInicial: { pk: "CONTROL", habilitado: false, motivo } });
    const r = await h.get();
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ v: 1, resultado: esperado });
    sinEscrituras(h);
  });

  it("falla al leer CONTROL -> cerrado: 500 interno, no entrega token", async () => {
    const h = crearArnes({ controlFalla: true });
    const r = await h.get();
    expect(r.statusCode).toBe(500);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "interno" });
    expect(r.body).not.toContain("form_token");
    sinDatosPersonales(h, [r.body]);
  });

  it("Origin ajeno o ausente -> 403 origen", async () => {
    const h = crearArnes();
    expect((await h.get({ headers: { origin: "https://evil.example.test" } })).statusCode).toBe(403);
    const r = await h.get({ headers: { origin: undefined } });
    expect(r.statusCode).toBe(403);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "origen" });
  });
});

describe("routing, headers y CORS (RFC 6.4)", () => {
  it("ninguna respuesta lleva Access-Control-*; todas Cache-Control: no-store y JSON", async () => {
    const h = crearArnes();
    const respuestas = [
      await h.get(),
      await h.post(h.cuerpoOrden()),
      await h.post(h.cuerpoOrden(), { headers: { origin: "https://evil.example.test" } }),
      await h.handler(h.evento("OPTIONS", "/v1/ordenes")),
      await h.handler(h.evento("GET", "/otra")),
      await h.post(undefined, { crudo: "{no es json" }),
    ];
    for (const r of respuestas) {
      const claves = Object.keys(r.headers).map((k) => k.toLowerCase());
      expect(claves.filter((k) => k.startsWith("access-control-"))).toEqual([]);
      expect(r.headers["cache-control"]).toBe("no-store");
      expect(r.headers["content-type"]).toContain("application/json");
      expect(JSON.parse(r.body).v).toBe(1);
    }
  });

  it("OPTIONS no se rutea: 405 sin tocar ningun puerto; otras rutas y metodos tampoco", async () => {
    const h = crearArnes();
    for (const [m, p] of [["OPTIONS", "/v1/ordenes"], ["OPTIONS", "/v1/estado"], ["PUT", "/v1/ordenes"], ["POST", "/v1/estado"], ["GET", "/v1/ordenes"]] as const) {
      expect((await h.handler(h.evento(m, p))).statusCode).toBe(405);
    }
    for (const p of ["/", "/v1/estado/", "/v1/ordenes/x", "/V1/ESTADO", "/v1"]) {
      expect((await h.handler(h.evento("GET", p))).statusCode).toBe(404);
    }
    sinEscrituras(h);
    expect(h.controlLecturas.n).toBe(0);
    expect(h.secretosLlamadas.n).toBe(0);
    expect(h.catalogoLlamadas.n).toBe(0);
    expect(canales(h)).toBe(0);
  });
});

describe("POST /v1/ordenes: orden aceptada (AC-10, AC-13, AC-17, AC-23, AC-24)", () => {
  it("201: un mail y un mensaje de Discord con el mismo numero que la respuesta; destinos fijos", async () => {
    const h = crearArnes();
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(201);
    const b = json(r);
    expect(b).toMatchObject({ v: 1, resultado: "aceptada" });
    expect(b["numero_orden"]).toMatch(/^RA-\d{5}$/);
    expect(b["recibida_en"]).toBe(new Date(AHORA0).toISOString());

    expect(h.mailInputs).toHaveLength(1);
    expect(h.discordLlamadas).toHaveLength(1);
    const mail = h.mailInputs[0]!;
    expect(mail.Content.Simple.Subject.Data).toContain(b["numero_orden"] as string);
    expect(mail.Content.Simple.Body.Text.Data).toContain(b["numero_orden"] as string);
    expect(mail.Content.Simple.Subject.Data).not.toContain("Zoilo");
    expect(mail.Destination).toEqual({ ToAddresses: [DESTINATARIO] });
    // Discord: siempre la URL de SSM; mismo numero y adjunto = texto del mail.
    const d = h.discordLlamadas[0]!;
    expect(d.url).toBe(`${URL_WEBHOOK}?wait=true`);
    const payload = JSON.parse(d.body.get("payload_json") as string) as { content: string };
    expect(payload.content.split("\n")[0]).toContain(b["numero_orden"] as string);
    expect(payload.content.split("\n")[0]).not.toContain("Zoilo");
    const adjunto = await (d.body.get("files[0]") as Blob).text();
    expect(adjunto).toBe(mail.Content.Simple.Body.Text.Data);
    expect(adjunto).toContain("Producto A");
    expect(adjunto).toContain("Producto B");
  });

  it("IDEM#: seudonimizado, TTL +90 dias en epoch-segundos, estados por canal; sin datos personales", async () => {
    const h = crearArnes();
    const cuerpo = h.cuerpoOrden();
    const r = await h.post(cuerpo);
    const item = [...h.items.values()][0]!;
    expect(item.pk).toBe(`IDEM#${cuerpo["idempotency_key"] as string}`);
    expect(item.expira_en).toBe(Math.floor(AHORA0 / 1000) + 90 * 24 * 3600);
    expect(item.mail_estado).toBe("entregado");
    expect(item.discord_estado).toBe("entregado");
    expect(item.payload_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(item.numero_orden).toBe(json(r)["numero_orden"]);
    sinDatosPersonales(h, [r.body]);
  });

  it("ledger y contadores: una escritura de ledger, aceptada por IP en hora y dia, cupo global una vez", async () => {
    const h = crearArnes();
    await h.post(h.cuerpoOrden());
    expect(h.writes.filter((w) => w.op === "ledger.sumar")).toHaveLength(1);
    expect(h.writes.filter((w) => w.op === "rl.consumirCupo")).toHaveLength(1);
    expect(h.writes.filter((w) => w.op === "rl.incrementar")).toHaveLength(2);
    expect(h.gasto()).toBeGreaterThan(0);
  });

  it("reintento con la misma key: 200, mismo numero, 0 envios nuevos, sin consumir cupo ni numero", async () => {
    const h = crearArnes();
    const cuerpo = h.cuerpoOrden();
    const primera = json(await h.post(cuerpo));
    const antes = h.writes.length;
    const cupoAntes = h.writes.filter((w) => w.op === "rl.consumirCupo").length;
    const otra = await h.post(cuerpo);
    expect(otra.statusCode).toBe(200);
    expect(json(otra)).toMatchObject({ resultado: "aceptada", numero_orden: primera["numero_orden"] });
    expect(h.mailInputs).toHaveLength(1);
    expect(h.discordLlamadas).toHaveLength(1);
    expect(h.writes.filter((w) => w.op === "rl.consumirCupo")).toHaveLength(cupoAntes);
    expect(h.writes.filter((w) => w.op === "num.reservar")).toHaveLength(1);
    // Solo el contador de POST por IP sube en el reintento.
    expect(h.writes.slice(antes).map((w) => w.op)).toEqual(["rl.incrementarCondicional"]);
  });

  it("misma key con otro nombre o telefono -> 422 errores [], sin envios", async () => {
    const h = crearArnes();
    const cuerpo = h.cuerpoOrden();
    await h.post(cuerpo);
    for (const contacto of [
      { nombre: "Otra Persona", telefono: TELEFONO_CANARIO },
      { nombre: NOMBRE_CANARIO, telefono: "+54 9 11 5550-9999" },
    ]) {
      const r = await h.post({ ...cuerpo, contacto });
      expect(r.statusCode).toBe(422);
      expect(json(r)).toEqual({ v: 1, resultado: "invalida", errores: [] });
    }
    expect(h.mailInputs).toHaveLength(1);
    expect(h.discordLlamadas).toHaveLength(1);
  });

  it("dos requests concurrentes con la misma key: 1 mail + 1 mensaje; la segunda -> en_proceso", async () => {
    const h = crearArnes({ retener: true });
    const cuerpo = h.cuerpoOrden();
    const p1 = h.post(cuerpo);
    while (h.mailInputs.length === 0 || h.discordLlamadas.length === 0) await new Promise((r) => setTimeout(r, 1));
    const r2 = await h.post(cuerpo);
    expect(r2.statusCode).toBe(503);
    expect(json(r2)).toEqual({ v: 1, resultado: "falla", codigo: "en_proceso" });
    h.liberar();
    expect((await p1).statusCode).toBe(201);
    expect(h.mailInputs).toHaveLength(1);
    expect(h.discordLlamadas).toHaveLength(1);
  });

  it("body en base64 (Function URL) se decodifica", async () => {
    const h = crearArnes();
    const ev = h.evento("POST", "/v1/ordenes", { crudo: Buffer.from(JSON.stringify(h.cuerpoOrden())).toString("base64") });
    ev.isBase64Encoded = true;
    expect((await h.handler(ev)).statusCode).toBe(201);
  });
});

describe("POST: flag apagado y tope (AC-22)", () => {
  it.each([
    ["tope_alcanzado", { v: 1, resultado: "tope_alcanzado" }],
    ["presupuesto", { v: 1, resultado: "tope_alcanzado" }],
    ["flood", { v: 1, resultado: "falla", codigo: "mantenimiento" }],
    ["manual", { v: 1, resultado: "falla", codigo: "mantenimiento" }],
    ["desconocido", { v: 1, resultado: "falla", codigo: "mantenimiento" }],
  ])("flag apagado (%s): 503, CERO escrituras, ningun canal, ni siquiera el catalogo", async (motivo, esperado) => {
    const h = crearArnes({ controlInicial: { pk: "CONTROL", habilitado: false, motivo } });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(503);
    expect(json(r)).toEqual(esperado);
    sinEscrituras(h);
    expect(canales(h)).toBe(0);
    expect(h.catalogoLlamadas.n).toBe(0);
    expect(h.items.size).toBe(0);
    sinDatosPersonales(h, [r.body]);
  });

  it("falla al leer CONTROL -> cerrado: 500 interno, cero escrituras, ningun canal", async () => {
    const h = crearArnes({ controlFalla: true });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(500);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "interno" });
    sinEscrituras(h);
    expect(canales(h)).toBe(0);
    sinDatosPersonales(h, [r.body]);
  });

  it("el ledger llega al 90 %: la orden en curso se entrega y las siguientes reciben tope_alcanzado", async () => {
    const h = crearArnes({ ledger: { budgetCapUsd: 0.0002 } });
    expect((await h.post(h.cuerpoOrden())).statusCode).toBe(201);
    expect(h.getControl()).toMatchObject({ habilitado: false, motivo: "tope_alcanzado" });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(503);
    expect(json(r)).toEqual({ v: 1, resultado: "tope_alcanzado" });
    expect(h.mailInputs).toHaveLength(1);
    expect(json(await h.get())).toEqual({ v: 1, resultado: "tope_alcanzado" });
  });
});

describe("POST: anti-abuso (AC-19)", () => {
  it("Origin ajeno o ausente -> 403 origen, ningun canal ni escritura", async () => {
    const h = crearArnes();
    for (const origin of ["https://evil.example.test", undefined, ORIGEN + ".evil.test"]) {
      const r = await h.post(h.cuerpoOrden(), { headers: { origin } });
      expect(r.statusCode).toBe(403);
      expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "origen" });
    }
    sinEscrituras(h);
    expect(canales(h)).toBe(0);
    expect(h.controlLecturas.n).toBe(0);
  });

  it("JSON invalido o body > 16 KB -> 422 / 413 invalida [], antes de Origin y sin escrituras", async () => {
    const h = crearArnes();
    const a = await h.post(undefined, { crudo: "{no es json" });
    expect(a.statusCode).toBe(422);
    expect(json(a)).toEqual({ v: 1, resultado: "invalida", errores: [] });
    const b = await h.post(undefined, { crudo: JSON.stringify({ x: "a".repeat(17 * 1024) }) });
    expect(b.statusCode).toBe(413);
    expect(json(b)).toEqual({ v: 1, resultado: "invalida", errores: [] });
    sinEscrituras(h);
  });

  it.each([
    ["ausente", (h: Arnes) => ({ ...h.cuerpoOrden(), form_token: undefined })],
    ["de < 3 s", (h: Arnes) => h.cuerpoOrden({ form_token: h.tokenValido(AHORA0 - 1000) })],
    ["de > 2 h", (h: Arnes) => h.cuerpoOrden({ form_token: h.tokenValido(AHORA0 - 2 * 3600 * 1000 - 1) })],
    ["ajeno (otro secreto)", (h: Arnes) => h.cuerpoOrden({ form_token: h.tokenValido().replace(/.$/, (c) => (c === "A" ? "B" : "A")) })],
    ["malformado", (h: Arnes) => h.cuerpoOrden({ form_token: "basura" })],
  ])("form_token %s -> 422 token_vencido, ningun canal", async (_n, armar) => {
    const h = crearArnes();
    const r = await h.post(armar(h));
    expect(r.statusCode).toBe(422);
    expect(json(r)).toEqual({ v: 1, resultado: "invalida", errores: [{ campo: "form_token", codigo: "token_vencido" }] });
    expect(canales(h)).toBe(0);
    expect(h.items.size).toBe(0);
    expect(h.writes.filter((w) => w.op.startsWith("idem") || w.op.startsWith("num") || w.op === "rl.consumirCupo")).toEqual([]);
  });

  it("honeypot con contenido -> 422 errores [], ningun canal", async () => {
    const h = crearArnes();
    const r = await h.post(h.cuerpoOrden({ sitio_web: "http://spam.example.test" }));
    expect(r.statusCode).toBe(422);
    expect(json(r)).toEqual({ v: 1, resultado: "invalida", errores: [] });
    expect(canales(h)).toBe(0);
    sinDatosPersonales(h, [r.body]);
  });

  it("la 21.a request por hora de la misma IP -> 429 limite_frecuencia", async () => {
    const h = crearArnes();
    for (let i = 0; i < 20; i++) await h.post(h.cuerpoOrden({ form_token: "x" }));
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(429);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "limite_frecuencia" });
    expect(canales(h)).toBe(0);
    // Otra IP no esta afectada.
    expect((await h.post(h.cuerpoOrden(), { ip: "198.51.100.9" })).statusCode).toBe(201);
  });

  it("la 4.a orden aceptada en la hora de la misma IP -> 429; los reintentos de una key no cuentan", async () => {
    const h = crearArnes();
    const primera = h.cuerpoOrden();
    for (const c of [primera, h.cuerpoOrden(), h.cuerpoOrden()]) expect((await h.post(c)).statusCode).toBe(201);
    expect((await h.post(primera)).statusCode).toBe(429); // la IP ya llego a 3 aceptadas
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(429);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "limite_frecuencia" });
    expect(h.mailInputs).toHaveLength(3);
  });

  it("cupo global agotado -> 503 limite_frecuencia, sin reservar IDEM# ni numero ni canales", async () => {
    const h = crearArnes({ umbrales: { ordenesPorDia: 1 } });
    expect((await h.post(h.cuerpoOrden(), { ip: "198.51.100.1" })).statusCode).toBe(201);
    const antes = h.writes.filter((w) => w.op === "idem.reservar" || w.op === "num.reservar").length;
    const r = await h.post(h.cuerpoOrden(), { ip: "198.51.100.2" });
    expect(r.statusCode).toBe(503);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "limite_frecuencia" });
    expect(h.writes.filter((w) => w.op === "idem.reservar" || w.op === "num.reservar")).toHaveLength(antes);
    expect(h.mailInputs).toHaveLength(1);
    expect(h.items.size).toBe(1);
  });

  it("el cupo global se consume solo con keys nuevas: el reintento de una orden aceptada no lo toca", async () => {
    const h = crearArnes({ umbrales: { ordenesPorDia: 1 } });
    const c = h.cuerpoOrden();
    expect((await h.post(c)).statusCode).toBe(201);
    expect((await h.post(c)).statusCode).toBe(200); // idempotente aun con el cupo en el limite
  });
});

describe("POST: validacion (AC-9, AC-17)", () => {
  it.each(["to", "cc", "bcc", "destinatario", "reply_to", "webhook", "canal", "thread_id", "email"])(
    "clave %s -> 422 no_permitido, ningun canal",
    async (clave) => {
      const h = crearArnes();
      const r = await h.post(h.cuerpoOrden({ [clave]: "ataque@example.test" }));
      expect(r.statusCode).toBe(422);
      expect(json(r)).toEqual({ v: 1, resultado: "invalida", errores: [{ campo: null, codigo: "no_permitido" }] });
      expect(canales(h)).toBe(0);
      expect(h.items.size).toBe(0);
      sinDatosPersonales(h, [r.body]);
    },
  );

  it("contacto con clave retirada (email/direccion) -> no_permitido", async () => {
    const h = crearArnes();
    const r = await h.post(h.cuerpoOrden({ contacto: { nombre: NOMBRE_CANARIO, telefono: TELEFONO_CANARIO, email: "a@example.test" } }));
    expect(json(r)["errores"]).toEqual([{ campo: null, codigo: "no_permitido" }]);
  });

  it("errores de nombre y telefono: solo campo y codigo, nunca el valor", async () => {
    const h = crearArnes();
    const r = await h.post(h.cuerpoOrden({ contacto: { nombre: "1", telefono: "12" } }));
    expect(r.statusCode).toBe(422);
    expect(json(r)["errores"]).toEqual([
      { campo: "contacto.nombre", codigo: "formato" },
      { campo: "contacto.telefono", codigo: "formato" },
    ]);
    expect(h.logs.join("\n")).toContain('"campo":"contacto.nombre"');
    expect(canales(h)).toBe(0);
  });

  it("total_visto inconsistente con sus lineas -> 422 total_visto/formato, sin catalogo ni canales", async () => {
    const h = crearArnes();
    const r = await h.post(h.cuerpoOrden({ total_visto: 1 }));
    expect(r.statusCode).toBe(422);
    expect(json(r)).toEqual({ v: 1, resultado: "invalida", errores: [{ campo: "total_visto", codigo: "formato" }] });
    expect(h.catalogoLlamadas.n).toBe(0);
    expect(canales(h)).toBe(0);
    expect(h.writes.filter((w) => w.op !== "rl.incrementarCondicional")).toEqual([]);
  });
});

describe("POST: catalogo (AC-15, AC-16)", () => {
  it("precio cambiado y producto inexistente -> 409 con precio_vigente y total_vigente; sin canales ni IDEM#/NUM#/cupo", async () => {
    const h = crearArnes();
    const r = await h.post(
      h.cuerpoOrden({
        lineas: [
          { producto_id: "A", cantidad: 1, precio_visto: 100 },
          { producto_id: "B", cantidad: 2, precio_visto: 1500 },
          { producto_id: "Z", cantidad: 1, precio_visto: 5 },
        ],
        total_visto: 100 + 3000 + 5,
      }),
    );
    expect(r.statusCode).toBe(409);
    expect(json(r)).toEqual({
      v: 1,
      resultado: "rechazada_por_catalogo",
      lineas: [
        { producto_id: "A", estado: "precio_cambiado", precio_vigente: 20000 },
        { producto_id: "Z", estado: "no_disponible" },
      ],
      total_vigente: 20000 + 3000,
    });
    expect(canales(h)).toBe(0);
    expect(h.items.size).toBe(0);
    expect(h.writes.filter((w) => w.op !== "rl.incrementarCondicional")).toEqual([]);
    sinDatosPersonales(h, [r.body]);
  });

  it("ante una discrepancia fuerza un refetch una vez y acepta si el catalogo ya cambio", async () => {
    const h = crearArnes();
    // Calienta la cache con el catalogo viejo.
    expect((await h.post(h.cuerpoOrden())).statusCode).toBe(201);
    expect(h.catalogoLlamadas.n).toBe(1);
    h.setCatalogo([
      { id: "A", proveedor: "P", categoria: "C", nombre: "Producto A", presentacion: "10 ml", descripcion: "d", imagen: "/i.png", precio_venta: 21000, en_oferta: false, tags: [] },
      { id: "B", proveedor: "P", categoria: "C", nombre: "Producto B", presentacion: "10 ml", descripcion: "d", imagen: "/i.png", precio_venta: 1500, en_oferta: false, tags: [] },
    ]);
    const nuevo = h.cuerpoOrden({
      lineas: [{ producto_id: "A", cantidad: 1, precio_visto: 21000 }],
      total_visto: 21000,
    });
    expect((await h.post(nuevo)).statusCode).toBe(201);
    expect(h.catalogoLlamadas.n).toBe(2);
  });

  it("catalogo no disponible -> 503 catalogo_no_disponible, sin cupo, numero, IDEM# ni canales", async () => {
    const h = crearArnes({ catalogoCae: true });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(503);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "catalogo_no_disponible" });
    expect(h.writes.filter((w) => w.op !== "rl.incrementarCondicional")).toEqual([]);
    expect(canales(h)).toBe(0);
    sinDatosPersonales(h, [r.body]);
  });

  it("una clave de costo inyectada en el catalogo no aparece en ningun canal ni respuesta", async () => {
    const h = crearArnes({
      catalogo: [
        { id: "A", proveedor: "P", categoria: "C", nombre: "Producto A", presentacion: "10 ml", descripcion: "d", imagen: "/i.png", precio_venta: 20000, en_oferta: false, tags: [], costo: 12345, precio_lista_laca: 9876 },
        { id: "B", proveedor: "P", categoria: "C", nombre: "Producto B", presentacion: "10 ml", descripcion: "d", imagen: "/i.png", precio_venta: 1500, en_oferta: false, tags: [] },
      ],
    });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(201);
    const todo = JSON.stringify(h.mailInputs) + (await (h.discordLlamadas[0]!.body.get("files[0]") as Blob).text()) + r.body + huella(h);
    expect(todo).not.toMatch(/12345|9876|costo|laca/i);
  });
});

describe("POST: canales (AC-20, AC-24, AC-25)", () => {
  it("mail entregado + Discord fallido -> 201 aceptada; una linea canal_fallido con orden_aceptada", async () => {
    const h = crearArnes({ discord: "fallido" });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(201);
    const lineas = h.logs.filter((l) => l.includes('"evento":"canal_fallido"'));
    expect(lineas).toHaveLength(1);
    expect(JSON.parse(lineas[0]!)).toMatchObject({ canal: "discord", codigo: "http_404", orden_aceptada: true });
    expect([...h.items.values()][0]).toMatchObject({ mail_estado: "entregado", discord_estado: "fallido" });
    sinDatosPersonales(h, [r.body]);
  });

  it("Discord entregado + mail incierto -> 201 aceptada", async () => {
    const h = crearArnes({ mail: "incierto" });
    expect((await h.post(h.cuerpoOrden())).statusCode).toBe(201);
    expect([...h.items.values()][0]).toMatchObject({ mail_estado: "incierto", discord_estado: "entregado" });
  });

  it("los dos fallidos -> 502 envio_fallido; el reintento reenvia los dos y acepta", async () => {
    const h = crearArnes({ mail: "fallido", discord: "fallido" });
    const cuerpo = h.cuerpoOrden();
    const r = await h.post(cuerpo);
    expect(r.statusCode).toBe(502);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "envio_fallido" });
    sinDatosPersonales(h, [r.body]);
    h.modos.mail = "ok";
    h.modos.discord = "ok";
    const r2 = await h.post(cuerpo);
    expect(r2.statusCode).toBe(201);
    expect(h.mailInputs).toHaveLength(2);
    expect(h.discordLlamadas).toHaveLength(2);
    // Mismo numero en los dos intentos.
    const numeros = h.mailInputs.map((m) => /RA-\d{5}/.exec(m.Content.Simple.Subject.Data)![0]);
    expect(new Set(numeros).size).toBe(1);
    expect(numeros[0]).toBe(json(r2)["numero_orden"]);
  });

  it("mail fallido + Discord incierto -> 502 envio_fallido; el reintento reenvia SOLO el fallido", async () => {
    const h = crearArnes({ mail: "fallido", discord: "incierto" });
    const cuerpo = h.cuerpoOrden();
    const r = await h.post(cuerpo);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "envio_fallido" });
    h.modos.mail = "ok";
    expect((await h.post(cuerpo)).statusCode).toBe(201);
    expect(h.mailInputs).toHaveLength(2);
    expect(h.discordLlamadas).toHaveLength(1);
  });

  it("los dos inciertos -> 502 estado_incierto; el reintento no reenvia nada (at-most-once)", async () => {
    const h = crearArnes({ mail: "incierto", discord: "incierto" });
    const cuerpo = h.cuerpoOrden();
    const r = await h.post(cuerpo);
    expect(r.statusCode).toBe(502);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "estado_incierto" });
    h.reloj.t += 60_000;
    h.modos.mail = "ok";
    h.modos.discord = "ok";
    const r2 = await h.post(cuerpo);
    expect(json(r2)).toEqual({ v: 1, resultado: "falla", codigo: "estado_incierto" });
    expect(h.mailInputs).toHaveLength(1);
    expect(h.discordLlamadas).toHaveLength(1);
    sinDatosPersonales(h, [r.body, r2.body]);
  });

  it("reintento con el catalogo caido (sin copia vigente): 503 y los canales reclamados vuelven a fallido", async () => {
    const h = crearArnes({ mail: "fallido", discord: "fallido" });
    const cuerpo = h.cuerpoOrden();
    await h.post(cuerpo);
    h.setCaido(true);
    h.reloj.t += 24 * 3600 * 1000 + 1; // la copia en memoria ya no es valida
    const r = await h.post({ ...cuerpo, form_token: h.tokenValido(h.reloj.t - 10_000) });
    expect(r.statusCode).toBe(503);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "catalogo_no_disponible" });
    expect([...h.items.values()][0]).toMatchObject({ mail_estado: "fallido", discord_estado: "fallido", mail_codigo: "catalogo" });
    expect(h.mailInputs).toHaveLength(1);
    expect(h.discordLlamadas).toHaveLength(1);
    // Con el catalogo de vuelta, el mismo reintento ya puede entregar.
    h.setCaido(false);
    h.modos.mail = "ok";
    h.modos.discord = "ok";
    expect((await h.post({ ...cuerpo, form_token: h.tokenValido(h.reloj.t - 10_000) })).statusCode).toBe(201);
  });

  it("reintento con el precio ya cambiado -> 409 y canales liberados, sin enviar", async () => {
    const h = crearArnes({ mail: "fallido", discord: "fallido" });
    const cuerpo = h.cuerpoOrden();
    await h.post(cuerpo);
    h.setCatalogo([
      { id: "A", proveedor: "P", categoria: "C", nombre: "Producto A", presentacion: "10 ml", descripcion: "d", imagen: "/i.png", precio_venta: 25000, en_oferta: false, tags: [] },
      { id: "B", proveedor: "P", categoria: "C", nombre: "Producto B", presentacion: "10 ml", descripcion: "d", imagen: "/i.png", precio_venta: 1500, en_oferta: false, tags: [] },
    ]);
    h.modos.mail = "ok";
    h.modos.discord = "ok";
    h.reloj.t += 6 * 60 * 1000; // vence la cache de 5 min: se revalida y ve el precio nuevo
    const r = await h.post(cuerpo);
    expect(r.statusCode).toBe(409);
    expect(json(r)["lineas"]).toEqual([{ producto_id: "A", estado: "precio_cambiado", precio_vigente: 25000 }]);
    expect([...h.items.values()][0]).toMatchObject({ mail_estado: "fallido", discord_estado: "fallido" });
    expect(h.mailInputs).toHaveLength(1);
  });
});

describe("cold start: secretos de SSM (decision 7)", () => {
  it("se cargan una vez por contenedor y se reusan entre requests", async () => {
    const h = crearArnes();
    await h.get();
    await h.post(h.cuerpoOrden());
    await h.post(h.cuerpoOrden());
    expect(h.secretosLlamadas.n).toBe(1);
  });

  it("sin secreto_hmac -> 500 interno, cerrado: cero escrituras y ningun canal", async () => {
    const h = crearArnes({ secretos: async () => Promise.reject(new Error("ssm " + NOMBRE_CANARIO + URL_WEBHOOK)) });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(500);
    expect(json(r)).toEqual({ v: 1, resultado: "falla", codigo: "interno" });
    sinEscrituras(h);
    expect(canales(h)).toBe(0);
    sinDatosPersonales(h, [r.body]);
  });

  it("sin URL de webhook: Discord queda fallido/config sin request y el mail igual acepta", async () => {
    const h = crearArnes({ secretos: async () => ({ hmac: SECRETO, urlWebhook: "" }) });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(201);
    expect(h.discordLlamadas).toHaveLength(0);
    expect([...h.items.values()][0]).toMatchObject({ discord_estado: "fallido", discord_codigo: "config" });
  });
});

describe("datos personales en logs y escrituras (AC-18, AC-26, AC-27)", () => {
  it("camino aceptada, invalida, rechazada_por_catalogo y canal fallido: ningun canario ni URL de webhook", async () => {
    const h = crearArnes({ discord: "fallido" });
    const respuestas: string[] = [];
    respuestas.push((await h.post(h.cuerpoOrden())).body); // aceptada con canal fallido
    respuestas.push((await h.post(h.cuerpoOrden({ total_visto: 3 }))).body); // invalida
    respuestas.push((await h.post(h.cuerpoOrden({ form_token: "x" }))).body); // token
    respuestas.push((await h.post(h.cuerpoOrden({ sitio_web: "x" }))).body); // honeypot
    respuestas.push(
      (await h.post(h.cuerpoOrden({ lineas: [{ producto_id: "A", cantidad: 1, precio_visto: 7 }], total_visto: 7 }))).body,
    ); // rechazada_por_catalogo
    respuestas.push((await h.post(h.cuerpoOrden(), { headers: { origin: "https://evil.example.test" } })).body);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.writes.length).toBeGreaterThan(0);
    sinDatosPersonales(h, respuestas);
    // Solo el numero de orden y codigos: ningun log trae la IP ni su HMAC.
    expect(huella(h)).not.toMatch(/198\.51\.100/);
  });

  it("canal fallido en los dos: sin datos personales en logs, escrituras ni respuesta", async () => {
    const h = crearArnes({ mail: "fallido", discord: "incierto" });
    const r = await h.post(h.cuerpoOrden());
    expect(r.statusCode).toBe(502);
    sinDatosPersonales(h, [r.body]);
  });

  it("errores internos: el log trae la etapa, nunca el mensaje de la excepcion", async () => {
    const h = crearArnes({ controlFalla: true });
    await h.post(h.cuerpoOrden());
    const l = h.logs.find((x) => x.includes("error_interno"))!;
    expect(JSON.parse(l)).toMatchObject({ evento: "error_interno", codigo: "control" });
    expect(l).not.toContain("dynamo caido");
  });
});

describe("reloj", () => {
  it("el token emitido por GET sirve para un POST pasados 3.5 s", async () => {
    const h = crearArnes();
    h.reloj.t = T0;
    const token = json(await h.get())["form_token"] as string;
    h.reloj.t = T0 + 3500;
    const r = await h.post(h.cuerpoOrden({ form_token: token }));
    expect(r.statusCode).toBe(201);
  });
});
