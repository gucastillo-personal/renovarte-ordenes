/**
 * Adaptador Lambda para `budget-guard` (B16). NO PROBADO CONTRA AWS REAL.
 *
 * Solo `PutFunctionConcurrency` y `DeleteFunctionConcurrency` sobre
 * `orders-http` (IAM acotada). Los errores del SDK se descartan: sus
 * mensajes pueden traer ARNs o ID de cuenta y no deben llegar a un log.
 */
import {
  DeleteFunctionConcurrencyCommand,
  PutFunctionConcurrencyCommand,
  type LambdaClient,
} from "@aws-sdk/client-lambda";
import type { ConcurrenciaOrdenes } from "../handlers/budget-guard.js";

export function crearConcurrenciaLambda(
  client: Pick<LambdaClient, "send">,
  functionName: string,
): ConcurrenciaOrdenes {
  return {
    async poner(n) {
      try {
        await client.send(
          new PutFunctionConcurrencyCommand({ FunctionName: functionName, ReservedConcurrentExecutions: n }),
        );
      } catch {
        throw new Error("lambda: PutFunctionConcurrency fallo");
      }
    },
    async quitar() {
      try {
        await client.send(new DeleteFunctionConcurrencyCommand({ FunctionName: functionName }));
      } catch {
        throw new Error("lambda: DeleteFunctionConcurrency fallo");
      }
    },
  };
}
