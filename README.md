# renovarte-ordenes

Servicio de órdenes de compra de RenovArte: recibe el pedido armado en el
carrito de `renovarte-catalogo`, lo valida contra el catálogo publicado y
lo entrega a RenovArte por dos canales (email y un canal privado de
Discord). Sin pagos ni envío en el sitio.

Repo **público**: no contiene ID de cuenta, ARNs reales, URLs de webhook
ni IDs de Discord. Los secretos viven en SSM Parameter Store
([ADR-0019](https://github.com/gucastillo-personal/renovarte-parent/blob/main/docs/decisions/ADR-0019-secretos-en-ssm.md)).

## Stack

AWS Lambda (Node.js 22, TypeScript, arm64) con Function URL, DynamoDB
on-demand y Amazon SES v2. Discord por webhook con `fetch` nativo. Diseño:
ADR-0006 y ADR-0016 en `renovarte-parent`, spec `0017-carrito-orden-compra`.

## Desarrollo

```
pnpm install
pnpm gate   # lint + typecheck + test + check:leak
```

## Pricing y límites vigentes

Pendiente B1 (verificación contra las páginas oficiales de SES, Lambda,
DynamoDB, Function URL, EventBridge Scheduler y Discord, con fecha).

| Servicio | Valor | Verificado el |
|---|---|---|
| SES (precio, sandbox) | pendiente B1 | pendiente |
| Lambda / DynamoDB / Function URL | pendiente B1 | pendiente |
| Discord (límites de `content`, rate limit, 429) | pendiente B1 | pendiente |

## Runbook

[`docs/runbook.md`](docs/runbook.md).
