import { describe, expect, it } from "vitest";
import {
  SES_MAX_ATTEMPTS,
  SES_TIMEOUT_MS,
  crearSesSender,
  type ClienteSes,
  type OpcionesEnvioSes,
  type SesEnviarInput,
} from "../src/lib/mail/ses-sender.js";
import { renderMail } from "../src/lib/mail/render.js";
import { NOMBRE, TELEFONO, ordenEntrega } from "./fixtures/orden-entrega.js";

const CONFIG = { destinatario: "ordenes@example.test", remitente: "no-reply@example.test" };

function cliente(respuesta: () => Promise<{ MessageId?: string }>) {
  const llamadas: { input: SesEnviarInput; opciones: OpcionesEnvioSes }[] = [];
  const c: ClienteSes = {
    async enviar(input, opciones) {
      llamadas.push({ input, opciones });
      return respuesta();
    },
  };
  return { c, llamadas };
}
const conStatus = (s: number) => Object.assign(new Error("secreto@nadie.test " + NOMBRE), { $metadata: { httpStatusCode: s } });

describe("crearSesSender: forma del envio", () => {
  it("Content.Simple, un solo destinatario fijo, sin Raw ni ReplyTo, con maxAttempts 1 y 4 s (AC-17)", async () => {
    const { c, llamadas } = cliente(async () => ({ MessageId: "m-1" }));
    const r = await crearSesSender(c, CONFIG).enviar(ordenEntrega());
    expect(r).toEqual({ estado: "entregado", message_id: "m-1" });
    const { input, opciones } = llamadas[0]!;
    expect(opciones).toEqual({ maxAttempts: 1, timeoutMs: 4000 });
    expect(SES_MAX_ATTEMPTS).toBe(1);
    expect(SES_TIMEOUT_MS).toBe(4000);
    expect(input.FromEmailAddress).toBe(CONFIG.remitente);
    expect(input.Destination).toEqual({ ToAddresses: [CONFIG.destinatario] });
    expect(Object.keys(input).sort()).toEqual(["Content", "Destination", "FromEmailAddress"]);
    expect(Object.keys(input.Destination)).toEqual(["ToAddresses"]);
    expect(Object.keys(input.Content)).toEqual(["Simple"]);
    expect(JSON.stringify(input)).not.toMatch(/ReplyTo|Raw/);
  });

  it("asunto sin datos personales; el nombre solo va en el cuerpo (AC-11)", async () => {
    const { c, llamadas } = cliente(async () => ({ MessageId: "m" }));
    await crearSesSender(c, CONFIG).enviar(ordenEntrega());
    const { Subject, Body } = llamadas[0]!.input.Content.Simple;
    const mail = renderMail(ordenEntrega());
    expect(Subject.Data).toBe(mail.asunto);
    expect(Subject.Data).not.toContain(NOMBRE);
    expect(Subject.Data).not.toContain(TELEFONO);
    expect(Body.Text.Data).toBe(mail.texto);
    expect(Body.Html.Data).toBe(mail.html);
  });

  it("un nombre con saltos de linea y headers no cambia destinatario ni headers", async () => {
    const { c, llamadas } = cliente(async () => ({ MessageId: "m" }));
    const o = { ...ordenEntrega(), contacto: { nombre: "X\r\nBcc: robo@example.test", telefono: TELEFONO } };
    await crearSesSender(c, CONFIG).enviar(o);
    const { input } = llamadas[0]!;
    expect(input.Destination.ToAddresses).toEqual([CONFIG.destinatario]);
    expect(input.Content.Simple.Subject.Data).not.toMatch(/[\r\n]/);
  });
});

describe("crearSesSender: validacion al arrancar", () => {
  const { c } = cliente(async () => ({}));
  it.each([
    ["vacio", ""],
    ["con coma (dos destinatarios)", "a@example.test,b@example.test"],
    ["con CRLF", "a@example.test\r\nBcc: b@example.test"],
    ["con nombre y angulares", "Ana <a@example.test>"],
    ["sin dominio", "a@"],
  ])("destinatario %s -> lanza sin incluir el valor", (_n, valor) => {
    expect(() => crearSesSender(c, { ...CONFIG, destinatario: valor })).toThrow(/ORDER_RECIPIENT_EMAIL/);
    try {
      crearSesSender(c, { ...CONFIG, destinatario: valor });
    } catch (e) {
      expect(String(e)).not.toContain("example.test");
    }
  });
  it("remitente invalido -> lanza", () => {
    expect(() => crearSesSender(c, { ...CONFIG, remitente: "nope" })).toThrow(/ORDER_SENDER_EMAIL/);
  });
});

describe("crearSesSender: clasificacion (AC-20)", () => {
  const correr = async (respuesta: () => Promise<{ MessageId?: string }>) =>
    crearSesSender(cliente(respuesta).c, CONFIG).enviar(ordenEntrega());

  it("MessageId -> entregado", async () => {
    expect(await correr(async () => ({ MessageId: "abc" }))).toEqual({ estado: "entregado", message_id: "abc" });
  });
  it("sin MessageId -> incierto", async () => {
    expect(await correr(async () => ({}))).toEqual({ estado: "incierto", codigo: "sin_message_id" });
    expect(await correr(async () => ({ MessageId: "" }))).toEqual({ estado: "incierto", codigo: "sin_message_id" });
  });
  it.each([400, 403, 404, 429])("%i -> fallido", async (s) => {
    expect(await correr(async () => Promise.reject(conStatus(s)))).toEqual({ estado: "fallido", codigo: `http_${s}` });
  });
  it.each([500, 503])("%i -> incierto", async (s) => {
    expect(await correr(async () => Promise.reject(conStatus(s)))).toEqual({ estado: "incierto", codigo: `http_${s}` });
  });
  it("error antes de conectar -> fallido", async () => {
    const e = Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } });
    expect(await correr(async () => Promise.reject(e))).toEqual({ estado: "fallido", codigo: "red" });
    const dns = Object.assign(new Error("x"), { code: "ENOTFOUND" });
    expect(await correr(async () => Promise.reject(dns))).toEqual({ estado: "fallido", codigo: "red" });
  });
  it("timeout -> incierto", async () => {
    const e = Object.assign(new Error("x"), { name: "TimeoutError" });
    expect(await correr(async () => Promise.reject(e))).toEqual({ estado: "incierto", codigo: "timeout" });
  });
  it("socket cortado -> incierto", async () => {
    const e = Object.assign(new Error("x"), { code: "ECONNRESET" });
    expect(await correr(async () => Promise.reject(e))).toEqual({ estado: "incierto", codigo: "socket_cortado" });
  });
  it("error desconocido -> incierto; el resultado nunca incluye el mensaje del error", async () => {
    const r = await correr(async () => Promise.reject(new Error("a@example.test " + NOMBRE)));
    expect(r).toEqual({ estado: "incierto", codigo: "error" });
    const r2 = await correr(async () => Promise.reject(conStatus(400)));
    expect(JSON.stringify(r2)).not.toContain(NOMBRE);
  });
});
