/**
 * Adaptador DynamoDB (B15). NO PROBADO CONTRA AWS REAL: sus tests usan un
 * cliente fake que solo verifica los comandos armados (B19 es el smoke real).
 *
 * Implementa los puertos de `src/lib` sobre una tabla unica con `pk`:
 * `ControlStore`, `RateLimitStore`, `IdempotenciaStore`, `NumeroStore` y
 * `LedgerStore`. Nunca expone `DeleteItem` (IAM tampoco lo da). Los items
 * se arman campo por campo con lo que entregan los modulos de `lib`, que ya
 * excluyen datos personales; este archivo no recibe la orden.
 */
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { ControlStore, ItemControl, Motivo } from "../lib/control.js";
import { CONTROL_PK } from "../lib/control.js";
import type { IdempotenciaStore, ItemIdem } from "../lib/idempotency.js";
import type { LedgerStore } from "../lib/ledger.js";
import type { NumeroStore } from "../lib/order-number.js";
import type { Contador, RateLimitStore } from "../lib/rate-limit.js";

/** Lo unico que se usa del `DynamoDBDocumentClient` (permite fakes). */
export type DocClientLike = Pick<DynamoDBDocumentClient, "send">;

export interface StoresDynamo {
  control: ControlStore;
  rateLimit: RateLimitStore;
  idempotencia: IdempotenciaStore;
  numero: NumeroStore;
  ledger: LedgerStore;
}

const nombreError = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null ? (e as { name?: string }).name : undefined;

const condicionFallida = (e: unknown): boolean => nombreError(e) === "ConditionalCheckFailedException";

export function crearStoresDynamo(doc: DocClientLike, tabla: string, ahoraMs: () => number = Date.now): StoresDynamo {
  const exp = (c: Contador) => ({ ":exp": c.expiraEn });

  const control: ControlStore = {
    async leer() {
      const r = await doc.send(new GetCommand({ TableName: tabla, Key: { pk: CONTROL_PK } }));
      return r.Item as ItemControl | undefined;
    },
    async apagar(motivo: Motivo) {
      await doc.send(
        new PutCommand({
          TableName: tabla,
          Item: { pk: CONTROL_PK, habilitado: false, motivo, actualizado_en: new Date(ahoraMs()).toISOString() },
        }),
      );
    },
  };

  const rateLimit: RateLimitStore = {
    async incrementarCondicional(c) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: tabla,
            Key: { pk: c.pk },
            UpdateExpression: "ADD n :uno SET expira_en = :exp",
            ConditionExpression: "attribute_not_exists(n) OR n < :limite",
            ExpressionAttributeValues: { ":uno": 1, ":limite": c.limite, ...exp(c) },
          }),
        );
        return true;
      } catch (e) {
        if (condicionFallida(e)) return false;
        throw e;
      }
    },
    async incrementar(pk, expiraEn) {
      await doc.send(
        new UpdateCommand({
          TableName: tabla,
          Key: { pk },
          UpdateExpression: "ADD n :uno SET expira_en = :exp",
          ExpressionAttributeValues: { ":uno": 1, ":exp": expiraEn },
        }),
      );
    },
    async leer(pk) {
      const r = await doc.send(new GetCommand({ TableName: tabla, Key: { pk }, ConsistentRead: true }));
      const n = (r.Item as { n?: unknown } | undefined)?.n;
      return typeof n === "number" ? n : 0;
    },
    async consumirCupo(dia, mes) {
      const update = (c: Contador) => ({
        Update: {
          TableName: tabla,
          Key: { pk: c.pk },
          UpdateExpression: "ADD n :uno SET expira_en = :exp",
          ConditionExpression: "attribute_not_exists(n) OR n < :limite",
          ExpressionAttributeValues: { ":uno": 1, ":limite": c.limite, ...exp(c) },
        },
      });
      try {
        await doc.send(new TransactWriteCommand({ TransactItems: [update(dia), update(mes)] }));
        return "ok";
      } catch (e) {
        if (nombreError(e) === "TransactionCanceledException") {
          const razones = (e as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
          if (razones[0]?.Code === "ConditionalCheckFailed") return "dia";
          if (razones[1]?.Code === "ConditionalCheckFailed") return "mes";
        }
        throw e;
      }
    },
  };

  const idempotencia: IdempotenciaStore = {
    async reservar(item: ItemIdem) {
      try {
        await doc.send(
          new PutCommand({ TableName: tabla, Item: item, ConditionExpression: "attribute_not_exists(pk)" }),
        );
        return true;
      } catch (e) {
        if (condicionFallida(e)) return false;
        throw e;
      }
    },
    async leer(pk) {
      const r = await doc.send(new GetCommand({ TableName: tabla, Key: { pk }, ConsistentRead: true }));
      return r.Item as ItemIdem | undefined;
    },
    async reclamar(pk, canal, ahora) {
      try {
        await doc.send(
          new UpdateCommand({
            TableName: tabla,
            Key: { pk },
            UpdateExpression: "SET #estado = :enviando, #intento = :ahora",
            ConditionExpression: "#estado = :fallido",
            ExpressionAttributeNames: { "#estado": `${canal}_estado`, "#intento": `${canal}_intento_en` },
            ExpressionAttributeValues: { ":enviando": "enviando", ":fallido": "fallido", ":ahora": ahora },
          }),
        );
        return true;
      } catch (e) {
        if (condicionFallida(e)) return false;
        throw e;
      }
    },
    async persistirCanal(pk, canal, intentoEn, resultado) {
      const detalle = resultado.estado === "entregado" ? "message_id" : "codigo";
      const valor = resultado.estado === "entregado" ? resultado.message_id : resultado.codigo;
      try {
        await doc.send(
          new UpdateCommand({
            TableName: tabla,
            Key: { pk },
            UpdateExpression: "SET #estado = :nuevo, #detalle = :valor",
            ConditionExpression: "#estado = :enviando AND #intento = :intentoEn",
            ExpressionAttributeNames: {
              "#estado": `${canal}_estado`,
              "#intento": `${canal}_intento_en`,
              "#detalle": `${canal}_${detalle}`,
            },
            ExpressionAttributeValues: {
              ":nuevo": resultado.estado,
              ":valor": valor,
              ":enviando": "enviando",
              ":intentoEn": intentoEn,
            },
          }),
        );
        return true;
      } catch (e) {
        if (condicionFallida(e)) return false;
        throw e;
      }
    },
  };

  const numero: NumeroStore = {
    async reservar(pk) {
      try {
        await doc.send(
          new PutCommand({
            TableName: tabla,
            Item: { pk, creado_en: new Date(ahoraMs()).toISOString() },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return true;
      } catch (e) {
        if (condicionFallida(e)) return false;
        throw e;
      }
    },
  };

  const ledger: LedgerStore = {
    async sumar(pk, usd, expiraEn) {
      const r = await doc.send(
        new UpdateCommand({
          TableName: tabla,
          Key: { pk },
          UpdateExpression: "ADD gasto_estimado_usd :usd SET expira_en = :exp",
          ExpressionAttributeValues: { ":usd": usd, ":exp": expiraEn },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      const g = (r.Attributes as { gasto_estimado_usd?: unknown } | undefined)?.gasto_estimado_usd;
      if (typeof g !== "number") throw new Error("ledger sin gasto_estimado_usd");
      return g;
    },
  };

  return { control, rateLimit, idempotencia, numero, ledger };
}
