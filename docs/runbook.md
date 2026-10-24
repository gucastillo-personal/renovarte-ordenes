# Runbook de renovarte-ordenes

> Sin valores reales: nada de ID de cuenta, ARNs, URLs ni
> IDs de Discord (repo público).

## Preparación de Discord (B24) — checklist

Manual del CTO/CEO. Estado: **pendiente**.

- [ ] Canal nuevo y privado para órdenes, visible solo para los propietarios.
- [ ] 2FA en las cuentas de los propietarios.
- [ ] Nadie más con "Gestionar webhooks" ni "Gestionar mensajes"; sin bots de terceros con lectura.
- [ ] Un webhook creado; su URL cargada en SSM con `put-parameter --overwrite` (sin eco, sin chat).
- [ ] Canal de prueba para B19.
- [ ] Firmada por el CTO/CEO (fecha): pendiente.

## Deploy

Pendiente (lo completa la infra, `plan.md ## Infra`).

## Rotación de secretos

Pendiente para el secreto HMAC (lo completa la infra).

### Rotar el webhook de Discord

Si la URL se filtró o hay que cambiarla (riesgo 3 del RFC):

1. En Discord, **borrar** el webhook viejo del canal y crear uno nuevo
   (el viejo deja de funcionar al instante; no expone los mensajes
   anteriores).
2. Cargar la URL nueva en SSM con `put-parameter --overwrite`, sin eco en
   la terminal y sin pasarla por chat ni por un archivo del repo. El nombre
   del parámetro es el de `DISCORD_WEBHOOK_PARAM`.
3. Forzar un cold start de `orders-http` (los secretos se leen una vez por
   contenedor): actualizar cualquier variable de entorno inocua de la
   función, o esperar a que expiren los contenedores.
4. Verificar con una orden de prueba en el canal de pruebas (B19).

## Kill-switch y corte de gasto

Hay tres capas (RFC 8): el ledger propio (corta al 90 % del tope con
`CONTROL` apagado y motivo `tope_alcanzado`), la reserved concurrency y el
`budget-guard`, que apaga `CONTROL` y deja la concurrency en 0 cuando
llega el aviso de AWS Budgets (100 %) o la alarma de flood. Una alarma que
vuelve a `OK` no reactiva nada.

### Reactivar a mano después de un tope o un flood

El reset automático corre el día 1 de cada mes (00:00 UTC). Para
reactivar antes, **primero revisar la causa** (logs de `orders-http`,
Budgets, métrica de la alarma de flood): reactivar sin entenderla puede
repetir el corte o el gasto.

Invocar `budget-guard` con el mismo evento que usa el schedule:

```
aws lambda invoke --function-name <budget-guard> \
  --cli-binary-format raw-in-base64-out --payload '{"mode":"reset"}' /dev/stdout
```

El orden es: primero `CONTROL` habilitado y después la concurrency
(`PutFunctionConcurrency(n)` si `ORDERS_HTTP_RESERVED_CONCURRENCY` tiene
valor; `DeleteFunctionConcurrency` si está vacía). Si el reset falla en
`CONTROL`, la concurrency no se toca y el servicio sigue cerrado. El reset
es idempotente: se puede repetir.

Cualquier disparo con formato desconocido apaga igual (fail-safe); si fue
una invocación de prueba, se revierte con el mismo reset.

Un `CONTROL` apagado con la concurrency ya restaurada (o al revés) es un
estado válido: las respuestas siguen la tabla de motivos del RFC 8.4
(`tope_alcanzado`/`presupuesto` → "tope"; `flood`/`desconocido`/`manual` →
mantenimiento).

## Rollback

Pendiente.

## Supresión de datos a pedido

No hay borrado automático (decisión del MVP, ADR-0020). Cuando un cliente
pida suprimir sus datos, a mano:

1. Buscar su orden por nombre, teléfono o número de orden en la casilla de
   RenovArte y **borrar el mail** (y vaciarlo de la papelera).
2. Buscar el mensaje en el canal privado de Discord y **borrarlo**
   (incluye el adjunto `.txt`).
3. DynamoDB no guarda nombre ni teléfono: no hay nada que borrar ahí
   (`IDEM#` solo tiene una huella seudonimizada, con TTL de 90 días).
4. Responder al cliente cuando esté hecho.

## Incidentes

### `estado_incierto`

Respuesta `502 falla`/`estado_incierto`: **los dos** canales quedaron
`incierto` (timeout o corte sin saber si entregó) o un reintento encontró
ese estado. El servicio no reintenta solo para no duplicar.

1. Buscar el número de orden (de los logs, `evento` y `numero_orden`) en la
   casilla y en el canal de Discord: es probable que la orden haya llegado
   por alguno.
2. Si llegó, no hacer nada más; si el cliente reclama, confirmarle por
   teléfono.
3. Si no llegó por ninguno, pedirle al cliente que arme la orden de nuevo
   (otra key) o tomarla por teléfono.

### `canal_fallido`

Línea de log `evento: "canal_fallido"` con `canal` (`mail`/`discord`) y
`codigo`; la alarma avisa por el topic operativo (separado del
kill-switch). Si `orden_aceptada` es `true` la orden llegó por el otro
canal: no se pierde, pero el canal está degradado.

- `config` en Discord: falta o es inválida la URL del webhook en SSM
  (rotar/cargar de nuevo, arriba).
- `http_404` en Discord: el webhook fue borrado.
- `http_429`: límite de Discord; suele ser transitorio.
- Mail: revisar la identidad verificada en SES y el sandbox.

Un canal que no entregó no se repara solo cuando la orden ya fue
`aceptada`; avisar a quien atiende las órdenes para que no dependa de ese
canal hasta resolverlo.

## Filtro de Gmail (opción A del remitente)

El remitente es la casilla verificada de RenovArte (opción A, RFC 10.1), y
un `From: @gmail.com` que no sale de servidores de Google puede ir a spam.
Mitigación: en Gmail, crear un filtro con asunto que contenga `Nueva orden
RA-` y la acción **Nunca enviar a spam**. La orden además llega por
Discord. Si aun con el filtro cae en spam en el smoke test (B19), escalar a
la opción B (dominio propio con DKIM, MAIL FROM y DMARC).

## Exportación a CSV o planilla

Hoy **no hay exportación**. Si algún día se exportan órdenes, neutralizar
(por ejemplo, anteponiendo un apóstrofo) todo valor que empiece con `=`,
`+`, `-`, `@`, tab o CR para evitar inyección de fórmulas.

## Desarrollo local

Ver el README (`pnpm dev:local`): usa puertos fake en memoria, sin AWS.
