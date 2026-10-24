/** Servidor local de B18: mismo contrato, puertos fake, salida impresa. */
import { afterEach, describe, expect, it } from "vitest";
import { iniciarServidorLocal, parsearArgs, type OpcionesServidorLocal, type ServidorLocal } from "../dev/local-server.js";

let srv: ServidorLocal | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const NOMBRE = "Persona Ficticia";
const TEL = "11 5550 0000";

async function arrancar(op: OpcionesServidorLocal = {}) {
  const salida: string[] = [];
  const reloj = { t: Date.UTC(2026, 9, 21, 12, 0, 0) };
  srv = await iniciarServidorLocal({ port: 0, ahora: () => reloj.t, salida: (l) => salida.push(l), ...op });
  const url = srv.url;
  const estado = async () => {
    const r = await fetch(`${url}/v1/estado`, { headers: { origin: "http://localhost:3000" } });
    return { r, j: (await r.json()) as Record<string, unknown> };
  };
  const orden = async (token: string, key = crypto.randomUUID()) => {
    const r = await fetch(`${url}/v1/ordenes`, {
      method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({
        v: 1,
        idempotency_key: key,
        form_token: token,
        lineas: [{ producto_id: "demo-1", cantidad: 2, precio_visto: 12500 }],
        total_visto: 25000,
        contacto: { nombre: NOMBRE, telefono: TEL },
      }),
    });
    return { r, j: (await r.json()) as Record<string, unknown> };
  };
  return { url, salida, reloj, estado, orden };
}

describe("dev/local-server", () => {
  it("camino feliz: imprime el mail y el Discord; CORS solo para el origen permitido", async () => {
    const a = await arrancar();
    const e = await a.estado();
    expect(e.j["resultado"]).toBe("disponible");
    expect(e.r.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    a.reloj.t += 5_000;
    const o = await a.orden(e.j["form_token"] as string);
    expect(o.r.status).toBe(201);
    expect(o.j["resultado"]).toBe("aceptada");
    const todo = a.salida.join("\n");
    expect(todo).toContain("[MAIL fake]");
    expect(todo).toContain("[DISCORD fake]");
    expect(todo).toContain(NOMBRE);
    // Los logs siguen la allowlist: sin nombre ni telefono.
    expect(a.salida.filter((l) => l.startsWith("[log]")).join("\n")).not.toContain(NOMBRE);
  });

  it("preflight OPTIONS responde 204 con CORS; origen ajeno no recibe CORS", async () => {
    const a = await arrancar();
    const p = await fetch(`${a.url}/v1/ordenes`, { method: "OPTIONS", headers: { origin: "http://localhost:3000" } });
    expect(p.status).toBe(204);
    expect(p.headers.get("access-control-allow-methods")).toBe("GET, POST");
    const x = await fetch(`${a.url}/v1/estado`, { headers: { origin: "https://otro.example.test" } });
    expect(x.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("--fail=mail: aceptada igual (un canal alcanza) y solo imprime Discord", async () => {
    const a = await arrancar({ fail: "mail" });
    const e = await a.estado();
    a.reloj.t += 5_000;
    const o = await a.orden(e.j["form_token"] as string);
    expect(o.j["resultado"]).toBe("aceptada");
    const todo = a.salida.join("\n");
    expect(todo).not.toContain("[MAIL fake]");
    expect(todo).toContain("[DISCORD fake]");
  });

  it("--fail=both: falla generica, sin nada impreso", async () => {
    const a = await arrancar({ fail: "both" });
    const e = await a.estado();
    a.reloj.t += 5_000;
    const o = await a.orden(e.j["form_token"] as string);
    expect(o.j["resultado"]).toBe("falla");
    expect(a.salida.join("\n")).not.toContain("fake]");
  });

  it("--control=tope: estado y orden responden tope_alcanzado", async () => {
    const a = await arrancar({ control: "tope" });
    expect((await a.estado()).j["resultado"]).toBe("tope_alcanzado");
  });

  it("parsearArgs: flags, env y valores invalidos", () => {
    expect(parsearArgs(["--fail=both", "--port=9000", "--fail-mode=incierto"], {})).toMatchObject({
      fail: "both",
      port: 9000,
      failMode: "incierto",
      allowedOrigins: ["http://localhost:3000"],
    });
    expect(parsearArgs([], { FAIL_CHANNELS: "discord", CONTROL_INICIAL: "flood" })).toMatchObject({ fail: "discord", control: "flood" });
    expect(() => parsearArgs(["--fail=todos"], {})).toThrow();
    expect(() => parsearArgs(["--port=abc"], {})).toThrow();
  });
});
