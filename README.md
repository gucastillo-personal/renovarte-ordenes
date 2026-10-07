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

Verificado el **2026-10-07** contra las páginas oficiales (spec 0017, B1).
Precios de us-east-1.

| Servicio | Valor | Fuente |
|---|---|---|
| SES | USD 0,10 por 1.000 mails; adjuntos USD 0,12/GB. Free tier actual: hasta USD 200 en créditos para cuentas nuevas (plan gratuito de 6 meses). La referencia vieja de "3.000 mails/mes por 12 meses" ya no aparece | aws.amazon.com/ses/pricing |
| SES sandbox | Solo a identidades verificadas, 200 mensajes por 24 h y 1 por segundo. Alcanza: el destinatario es uno solo y verificado | docs.aws.amazon.com/ses (request-production-access) |
| SDK de AWS (reintentos) | `maxAttempts` cuenta el intento inicial: `1` desactiva los reintentos. DynamoDB usa 4 por defecto | docs.aws.amazon.com/sdkref (retry behavior) |
| Lambda arm64 | USD 0,0000133334 por GB-s y USD 0,20 por 1 M de requests. Siempre gratis: 1 M requests y 400.000 GB-s por mes. Function URL sin cargo aparte | aws.amazon.com/lambda/pricing |
| DynamoDB on-demand | USD 0,625 por M de escrituras y USD 0,125 por M de lecturas; 25 GB de almacenamiento gratis. El cargo de TTL no figura en la página | aws.amazon.com/dynamodb/pricing/on-demand |
| Transferencia saliente | 100 GB por mes gratis, sumando todos los servicios | aws.amazon.com/ec2/pricing/on-demand |
| Discord, `content` | 2.000 caracteres máximo | docs.discord.com (webhook) |
| Discord, `?wait=true` | Devuelve el mensaje creado; sin él no confirma | docs.discord.com (webhook) |
| Discord, adjuntos | 20 MiB por archivo por defecto | docs.discord.com (reference) |
| Discord, borrado | `DELETE /webhooks/{id}/{token}/messages/{id}` responde 204; códigos `10008` (mensaje desconocido) y `10015` (webhook desconocido) | docs.discord.com |
| Discord, 429 | Cuerpo con `retry_after` (segundos, decimal) y `global`; headers `X-RateLimit-*` | docs.discord.com (rate limits) |
| Discord, `User-Agent` | La documentación exige un `User-Agent` válido en las llamadas HTTP; sin él puede haber errores de Cloudflare | docs.discord.com (reference) |

**No verificado todavía:**

- Que el webhook de Discord sea gratis (no está dicho en las páginas consultadas).
- Los límites propios del webhook (~5 requests cada 2 s y ~30 mensajes por minuto por canal): la documentación no los publica.
- El header `Retry-After` en el 429 (solo se confirmó `retry_after` en el cuerpo).
- Si el free tier de 12 meses de la cuenta de AWS sigue vigente (solo se ve en Billing).

## Runbook

[`docs/runbook.md`](docs/runbook.md).
