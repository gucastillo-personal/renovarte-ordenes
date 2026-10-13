import { describe, expect, it } from "vitest";
import { crearLogger, filtrarCampos } from "../src/lib/log.js";

const NOMBRE = "Zoilo Canarión";
const TEL = "+54 9 11 5550-1234";

function setup() {
  const lineas: string[] = [];
  const logger = crearLogger((l) => lineas.push(l), () => Date.UTC(2026, 9, 13, 17, 5, 0));
  return { lineas, logger };
}

describe("log (AC-18, AC-26)", () => {
  it("descarta nombre, telefono, contacto, IP, body, URL de webhook y body de Discord", () => {
    const { lineas, logger } = setup();
    logger.log("error", {
      evento: "canal_fallido",
      canal: "discord",
      codigo: "http_404",
      numero_orden: "RA-48271",
      http_status: 404,
      orden_aceptada: true,
      nombre: NOMBRE,
      telefono: TEL,
      contacto: { nombre: NOMBRE, telefono: TEL },
      nombre_largo: NOMBRE.length,
      ip: "203.0.113.9",
      body: JSON.stringify({ contacto: { nombre: NOMBRE } }),
      webhook_url: "https://example.invalid/hook",
      discord_body: `{"content":"${NOMBRE} ${TEL}"}`,
      error: new Error(NOMBRE),
    });
    const l = lineas[0]!;
    for (const s of [NOMBRE, TEL, "203.0.113.9", "example.invalid"]) expect(l).not.toContain(s);
    expect(JSON.parse(l)).toEqual({
      ts: "2026-10-13T17:05:00.000Z",
      nivel: "error",
      evento: "canal_fallido",
      canal: "discord",
      codigo: "http_404",
      numero_orden: "RA-48271",
      http_status: 404,
      orden_aceptada: true,
    });
  });
  it("error de validacion: solo campo y codigo, nunca el valor", () => {
    const { lineas, logger } = setup();
    logger.logValidacion("contacto.nombre", "demasiado_largo");
    const o = JSON.parse(lineas[0]!);
    expect(o).toMatchObject({ evento: "validacion", campo: "contacto.nombre", codigo: "demasiado_largo" });
    expect(Object.keys(o).sort()).toEqual(["campo", "codigo", "evento", "nivel", "ts"]);
  });
  it("solo pasan primitivos, y los strings se acotan", () => {
    const f = filtrarCampos({ codigo: { x: 1 }, canal: "x".repeat(500), http_status: NaN, resultado: ["a"] });
    expect(f).toEqual({ canal: "x".repeat(120) });
  });
});
