/**
 * Adaptadores de AWS (B15). NO PROBADOS CONTRA AWS REAL: solo se verifica,
 * con clientes fake, la forma de los comandos y el mapeo de errores.
 * (`aws-sdk-client-mock` no esta instalado.)
 */
import { describe, expect, it } from "vitest";
import { crearStoresDynamo, type DocClientLike } from "../src/adapters/dynamo.js";
import { crearClienteSes, crearClienteSdkSes } from "../src/adapters/ses.js";
import { cargarSecretosSsm } from "../src/adapters/ssm.js";
import { construirDepsHttp } from "../src/handlers/index.js";

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function fakeDoc(responder: (c: Cmd) => unknown = () => ({})) {
  const cmds: Cmd[] = [];
  const doc = {
    send: async (c: Cmd) => {
      cmds.push(c);
      const r = responder(c);
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as DocClientLike;
  return { doc, cmds };
}
const err = (name: string, extra: object = {}) => Object.assign(new Error(name), { name, ...extra });

describe("adapters/dynamo", () => {
  const t = () => Date.UTC(2026, 9, 14);

  it("control: Get/Put de CONTROL", async () => {
    const { doc, cmds } = fakeDoc((c) => (c.constructor.name === "GetCommand" ? { Item: { pk: "CONTROL", habilitado: true } } : {}));
    const s = crearStoresDynamo(doc, "tabla", t);
    expect(await s.control.leer()).toEqual({ pk: "CONTROL", habilitado: true });
    await s.control.apagar("flood");
    expect(cmds[1]!.constructor.name).toBe("PutCommand");
    expect(cmds[1]!.input["Item"]).toMatchObject({ pk: "CONTROL", habilitado: false, motivo: "flood" });
  });

  it("rate limit: ADD condicional; ConditionalCheckFailed -> false; otro error se propaga", async () => {
    let modo: "ok" | "cond" | "otro" = "ok";
    const { doc, cmds } = fakeDoc(() => (modo === "cond" ? err("ConditionalCheckFailedException") : modo === "otro" ? err("ThrottlingException") : {}));
    const s = crearStoresDynamo(doc, "tabla", t);
    expect(await s.rateLimit.incrementarCondicional({ pk: "RL#x", limite: 20, expiraEn: 99 })).toBe(true);
    expect(cmds[0]!.input).toMatchObject({
      Key: { pk: "RL#x" },
      UpdateExpression: "ADD n :uno SET expira_en = :exp",
      ConditionExpression: "attribute_not_exists(n) OR n < :limite",
      ExpressionAttributeValues: { ":uno": 1, ":limite": 20, ":exp": 99 },
    });
    modo = "cond";
    expect(await s.rateLimit.incrementarCondicional({ pk: "RL#x", limite: 20, expiraEn: 99 })).toBe(false);
    modo = "otro";
    await expect(s.rateLimit.incrementarCondicional({ pk: "RL#x", limite: 20, expiraEn: 99 })).rejects.toThrow();
  });

  it("cupo: transaccion de dos contadores; mapea cual limite fallo", async () => {
    const cancelar = (r: Array<string | undefined>) =>
      err("TransactionCanceledException", { CancellationReasons: r.map((Code) => ({ Code })) });
    let res: unknown = {};
    const { doc, cmds } = fakeDoc(() => res);
    const s = crearStoresDynamo(doc, "tabla", t);
    const c = (pk: string) => ({ pk, limite: 5, expiraEn: 1 });
    expect(await s.rateLimit.consumirCupo(c("CUPO#dia#x"), c("CUPO#mes#x"))).toBe("ok");
    expect((cmds[0]!.input["TransactItems"] as unknown[]).length).toBe(2);
    res = cancelar(["ConditionalCheckFailed", "None"]);
    expect(await s.rateLimit.consumirCupo(c("a"), c("b"))).toBe("dia");
    res = cancelar(["None", "ConditionalCheckFailed"]);
    expect(await s.rateLimit.consumirCupo(c("a"), c("b"))).toBe("mes");
    res = cancelar(["None", "ThrottlingError"]);
    await expect(s.rateLimit.consumirCupo(c("a"), c("b"))).rejects.toThrow();
  });

  it("idempotencia: reserva con attribute_not_exists; claim y persistencia condicionados", async () => {
    let res: unknown = {};
    const { doc, cmds } = fakeDoc(() => res);
    const s = crearStoresDynamo(doc, "tabla", t);
    const item = { pk: "IDEM#k", numero_orden: "RA-00001" } as never;
    expect(await s.idempotencia.reservar(item)).toBe(true);
    expect(cmds[0]!.input["ConditionExpression"]).toBe("attribute_not_exists(pk)");
    res = err("ConditionalCheckFailedException");
    expect(await s.idempotencia.reservar(item)).toBe(false);
    expect(await s.idempotencia.reclamar("IDEM#k", "mail", 5)).toBe(false);
    expect(await s.idempotencia.persistirCanal("IDEM#k", "discord", 5, { estado: "fallido", codigo: "http_404" })).toBe(false);
    res = {};
    await s.idempotencia.reclamar("IDEM#k", "mail", 5);
    expect(cmds.at(-1)!.input).toMatchObject({
      ConditionExpression: "#estado = :fallido",
      ExpressionAttributeNames: { "#estado": "mail_estado", "#intento": "mail_intento_en" },
    });
    await s.idempotencia.persistirCanal("IDEM#k", "mail", 5, { estado: "entregado", message_id: "m-1" });
    expect(cmds.at(-1)!.input).toMatchObject({
      ConditionExpression: "#estado = :enviando AND #intento = :intentoEn",
      ExpressionAttributeNames: { "#detalle": "mail_message_id" },
      ExpressionAttributeValues: { ":nuevo": "entregado", ":valor": "m-1", ":intentoEn": 5 },
    });
  });

  it("nunca emite DeleteCommand; ledger devuelve el acumulado", async () => {
    const { doc, cmds } = fakeDoc((c) => (c.constructor.name === "UpdateCommand" ? { Attributes: { gasto_estimado_usd: 1.5 } } : {}));
    const s = crearStoresDynamo(doc, "tabla", t);
    expect(await s.ledger.sumar("LEDGER#2026-10", 0.1, 9)).toBe(1.5);
    await s.numero.reservar("NUM#RA-00001");
    expect(cmds.map((c) => c.constructor.name)).not.toContain("DeleteCommand");
    expect(cmds[0]!.input["ReturnValues"]).toBe("UPDATED_NEW");
  });
});

describe("adapters/ses", () => {
  it("el cliente real se construye con maxAttempts 1; enviar pasa un abortSignal", async () => {
    const real = crearClienteSdkSes("us-east-1");
    expect(await real.config.maxAttempts()).toBe(1);
    const llamadas: Array<{ cmd: Cmd; opts: { abortSignal?: AbortSignal } }> = [];
    const c = crearClienteSes({ send: async (cmd: never, opts: never) => (llamadas.push({ cmd, opts }), { MessageId: "m-9" }) } as never);
    const r = await c.enviar({ FromEmailAddress: "a@example.test", Destination: { ToAddresses: ["b@example.test"] }, Content: { Simple: { Subject: { Data: "s", Charset: "UTF-8" }, Body: { Text: { Data: "t", Charset: "UTF-8" }, Html: { Data: "h", Charset: "UTF-8" } } } } }, { maxAttempts: 1, timeoutMs: 4000 });
    expect(r).toEqual({ MessageId: "m-9" });
    expect(llamadas[0]!.opts.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("adapters/ssm", () => {
  const nombres = { hmac: "/x/hmac", webhook: "/x/webhook" };
  it("lee los dos parametros en paralelo, con descifrado", async () => {
    const pedidos: string[] = [];
    let resolver: Array<() => void> = [];
    const client = {
      send: (cmd: Cmd) =>
        new Promise((res) => {
          pedidos.push(cmd.input["Name"] as string);
          expect(cmd.input["WithDecryption"]).toBe(true);
          resolver.push(() => res({ Parameter: { Value: `v:${cmd.input["Name"] as string}` } }));
        }),
    };
    const p = cargarSecretosSsm(client as never, nombres);
    await Promise.resolve();
    expect(pedidos).toEqual(["/x/hmac", "/x/webhook"]); // ambos en vuelo antes de resolver alguno
    resolver.forEach((f) => f());
    expect(await p).toEqual({ hmac: "v:/x/hmac", urlWebhook: "v:/x/webhook" });
    resolver = [];
  });

  it("sin HMAC rechaza; sin webhook devuelve urlWebhook vacia; el mensaje original no se propaga", async () => {
    const falla = (cual: string) => ({
      send: async (cmd: Cmd) => {
        if (cmd.input["Name"] === cual) throw new Error("detalle sensible " + cual);
        return { Parameter: { Value: "valor" } };
      },
    });
    await expect(cargarSecretosSsm(falla("/x/hmac") as never, nombres)).rejects.toThrow(/^ssm: secreto_hmac no disponible$/);
    expect(await cargarSecretosSsm(falla("/x/webhook") as never, nombres)).toEqual({ hmac: "valor", urlWebhook: "" });
  });
});

describe("handlers/index: configuracion", () => {
  it("falta una env var -> falla al construir (cerrado)", () => {
    expect(() => construirDepsHttp({})).toThrow(/config ausente/);
  });
});
