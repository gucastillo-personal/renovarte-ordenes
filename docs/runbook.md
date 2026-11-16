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

## Configuración del repo en GitHub (I20) — checklist

Manual del CTO/CEO (USD 0). Evidencia: marcar y pegar en el PR (sin IDs
reales ni capturas con datos de la cuenta).

- [ ] Ruleset sobre `main`: PR obligatorio, sin force push ni borrado, check
  requerido `gate` (y `terraform`).
- [ ] Secret scanning activado (Settings → Code security).
- [ ] Push protection activada.
- [ ] Settings → Actions → "Require approval for all external contributors"
  (workflows de PRs de forks) y permisos por defecto del `GITHUB_TOKEN` en
  solo lectura.
- [ ] Variable del repo (no secreto) `AWS_DEPLOY_ROLE_ARN` cargada con el
  ARN del rol de deploy (`terraform output`; se carga tras el primer
  `apply`).
- [ ] Verificado por el CTO/CEO (fecha): pendiente.

## Bootstrap IAM (I2) — lo hace el CTO/CEO

El usuario que corre `terraform apply` se crea a mano, una sola vez. La
policy vive en `terraform/iam-bootstrap-policy.json` (gitignoreada) y usa el
placeholder `<ACCOUNT_ID>`: reemplazarlo por el ID de la cuenta solo en la
copia local, nunca en un archivo versionado. Si llega la opción B del
remitente (identidad de dominio), sumar a mano el ARN de esa identidad al
statement `SesExactIdentity`.

```bash
# 1. Policy y usuario (con un perfil admin, a mano)
aws iam create-policy --policy-name renovarte-ordenes-terraform-bootstrap \
  --policy-document file://terraform/iam-bootstrap-policy.json
aws iam create-user --user-name renovarte-ordenes-terraform
aws iam attach-user-policy --user-name renovarte-ordenes-terraform \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/renovarte-ordenes-terraform-bootstrap
aws iam create-access-key --user-name renovarte-ordenes-terraform

# 2. Perfil local (pegar la clave a mano; no va a chat ni a git)
aws configure --profile renovarte-ordenes-terraform
export AWS_PROFILE=renovarte-ordenes-terraform
aws sts get-caller-identity
```

El provider OIDC de GitHub es un singleton de la cuenta: **no** lo gestiona
este repo ni esta policy (I-D10). Si no existe, se crea a mano
(`aud = sts.amazonaws.com`) y su ARN llega como `github_oidc_provider_arn`.

## Deploy

Dos caminos separados (I-D10): la **infra** se aplica siempre a mano y el
**código** de las Lambdas se despliega con un workflow.

### Infra (Terraform, a mano, con aprobación humana)

Estado local (sin backend remoto); `terraform.tfvars` está gitignoreado.
Prerrequisitos: Terraform >= 1.11 (por `value_wo`), el perfil del usuario de
bootstrap (sección "Bootstrap IAM (I2)") y `pnpm build` hecho, porque
`archive_file` empaqueta `dist/` en `plan` y `apply`.

```bash
pnpm build
cd terraform
cp terraform.tfvars.example terraform.tfvars   # completar con valores reales
terraform init
terraform plan                                 # revisar antes de aplicar
terraform apply                                # solo el CTO/CEO, en vivo
```

Después del primer `apply`, en este orden:

1. Hacer clic en el mail de verificación de SES (vence en 24 h).
2. Confirmar la suscripción email del topic de alertas operativas (mail de
   AWS Notifications; hasta que se confirme no llega ninguna alerta).
3. Cargar los parámetros SSM (sección siguiente).
4. Pasar `orders_api_url` a Vercel (solo Production) y el ARN del rol de
   deploy (`terraform output github_deploy_role_arn`) a la variable del
   repo `AWS_DEPLOY_ROLE_ARN`.

Ningún workflow corre `terraform plan` ni `apply`: el CI solo hace
`fmt -check`, `init -backend=false` y `validate`.

### Código (workflow `Deploy`)

Actions → **Deploy** → *Run workflow* sobre `main` (el guard rechaza otra
rama). Corre `pnpm gate` y `pnpm build`, asume por OIDC el rol de deploy
(variable del repo `AWS_DEPLOY_ROLE_ARN`) y hace `update-function-code` +
`wait function-updated` sobre `orders-http` y `budget-guard`. El rol solo
puede actualizar código: no toca IAM, env vars, concurrency ni SSM. Un
cambio de variables o de recursos va por Terraform, no por este workflow.

## Parámetros SSM (secreto HMAC y URL del webhook)

Terraform crea los dos parámetros `SecureString` con un placeholder
(`value_wo`, write-only: el valor real nunca está en el estado ni en el
plan) y **no los vuelve a tocar** mientras no cambie `value_wo_version`. El
valor real lo carga una persona, sin eco en la terminal, sin pasarlo por
chat ni por un archivo del repo. Mientras quede el placeholder, el canal
Discord falla con `config` y dispara la alarma `canal-degradado`: es lo
esperado antes de cargarlo.

```bash
# Secreto HMAC (generado localmente)
V=$(openssl rand -base64 32)
aws ssm put-parameter --name /renovarte-ordenes/hmac-secret \
  --type SecureString --overwrite --value "$V"; unset V

# URL del webhook de Discord (pegarla; no se muestra)
read -rs V
aws ssm put-parameter --name /renovarte-ordenes/discord-webhook-url \
  --type SecureString --overwrite --value "$V"; unset V
```

Las Lambdas leen los secretos una vez por contenedor. Para que los
contenedores calientes los relean: **subir `config_revision`** en
`terraform.tfvars` y correr `terraform plan` + `apply` (cambia la env var
`CONFIG_REVISION`). Rotar el HMAC invalida los `form_token` emitidos y los
`payload_hmac` de reintentos en curso; hacerlo en un momento de poco
tráfico.

## Rotación de secretos

Secreto HMAC: mismo procedimiento que en "Parámetros SSM" (`put-parameter
--overwrite`, subir `config_revision`, `apply`).

### Rotar el webhook de Discord

Si la URL se filtró o hay que cambiarla (riesgo 3 del RFC):

1. En Discord, **borrar** el webhook viejo del canal y crear uno nuevo
   (el viejo deja de funcionar al instante; no expone los mensajes
   anteriores).
2. Cargar la URL nueva en SSM con `put-parameter --overwrite`, sin eco en
   la terminal y sin pasarla por chat ni por un archivo del repo. El nombre
   del parámetro es el de `DISCORD_WEBHOOK_PARAM`.
3. Forzar que `orders-http` relea el secreto (se lee una vez por
   contenedor): subir `config_revision` en `terraform.tfvars` y `apply`
   (ver "Parámetros SSM"), o esperar a que expiren los contenedores.
   Después, borrar a mano los mensajes del webhook viejo de menos de 60
   días.
4. Verificar con una orden de prueba en el canal de pruebas (B19).

## Alarmas y alertas operativas

Dos alarmas de CloudWatch (de las 10 gratis de la cuenta; I-D13). Los
emails no llevan datos personales: traen el nombre de la alarma, la
métrica y el umbral, nunca el contenido del log.

| Alarma | Qué significa | Topic |
|---|---|---|
| `renovarte-ordenes-flood` | `orders-http` superó las invocaciones por minuto del umbral (`flood_invocations_per_minute`): el kill-switch **ya apagó** el servicio | kill-switch (budget-guard) **y** alertas operativas (el email) |
| `renovarte-ordenes-canal-degradado` | Al menos una línea `canal_fallido` en 5 min: un canal (mail o Discord) no entregó. **No** apaga el servicio | alertas operativas |

Para ver el detalle sin datos personales (el logger solo emite campos de
la allowlist: evento, canal, código, número de orden), Logs Insights sobre
el log group `/aws/lambda/renovarte-ordenes-orders-http`:

```
fields @timestamp, evento, canal, codigo, orden_aceptada, numero_orden
| filter evento = "canal_fallido"
| sort @timestamp desc
| limit 50
```

(Para el flood, mirar la métrica `Invocations` de `orders-http` y los logs
del `budget-guard`.) Qué hacer con un canal caído: ver "Incidentes". Una
alarma que vuelve a `OK` no reactiva nada.

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

### Reactivar sin el reset (a mano, paso a paso)

Alternativa a invocar `budget-guard`, con el mismo orden: primero `CONTROL`
y después la concurrency.

1. Habilitar `CONTROL` (item de la tabla `renovarte-ordenes-datos`,
   `pk = CONTROL`): `aws dynamodb put-item` con `habilitado = true`, o
   borrar el item (sin item = habilitado).
2. Restaurar la concurrency de `orders-http`:
   `aws lambda put-function-concurrency --function-name <orders-http>
   --reserved-concurrent-executions <N>` (el valor de
   `orders_http_reserved_concurrency`), o
   `aws lambda delete-function-concurrency --function-name <orders-http>`
   si la cuenta no tiene reserva (`null`).
3. Verificar con `GET /v1/estado` (debe responder `disponible`).

### Cambiar la reserved concurrency (I-D4)

Cambiar `orders_http_reserved_concurrency` en `terraform.tfvars` actualiza
la env var que usa `budget-guard` en el reset, pero **no** la reserva real:
la función tiene `ignore_changes` sobre `reserved_concurrent_executions`.
Hay que correr además `put-function-concurrency` (o
`delete-function-concurrency` si pasa a `null`) a mano.

### No aplicar con el kill-switch activo

Con el servicio apagado (concurrency en 0 o `CONTROL` deshabilitado) **no
correr `terraform apply` que toque la concurrency** ni la función
`orders-http`: aunque `ignore_changes` evita que Terraform la restaure en
silencio, mezclar un apply con un corte activo oculta la causa. Primero
revisar y reactivar (arriba), después aplicar.

## Opción B del remitente (dominio propio)

Si el filtro de Gmail no alcanza (ver abajo) o hace falta un remitente
propio: poner `sender_domain` en `terraform.tfvars`, `plan` y `apply`.
Crea la identidad de dominio con Easy DKIM y MAIL FROM propio; los
registros DNS (los `ses_dkim_tokens` del output, MX/SPF de MAIL FROM y
DMARC `p=none`) se cargan a mano en el registrador. Sumar a mano el ARN de
la identidad al statement `SesExactIdentity` de la policy de bootstrap
(sección "Bootstrap IAM (I2)"). Verificar la identidad antes de cambiar
`order_sender_email`.

## Verificar la identidad SES

Opción A: el mail de verificación de SES al destinatario (y al remitente,
si difiere) vence en 24 h; si venció, `terraform apply` no lo reenvía:
usar `aws sesv2 delete-email-identity` + `apply`, o reenviarlo desde la
consola. Estado: `aws sesv2 get-email-identity --email-identity <email>`
(`VerifiedForSendingStatus = true`). SES queda en sandbox: solo envía a
identidades verificadas.

## Riesgos conocidos

- Estado de Terraform **local**: sin backup ni lock; perderlo obliga a
  importar los recursos. Hacer copia fuera del repo antes de cada `apply`.
- `value_wo` no se refleja en el estado: Terraform no detecta si alguien
  cambia el valor en SSM a mano (es lo buscado).
- El primer `apply` deja los parámetros con placeholder: hasta cargarlos,
  Discord falla (alerta esperada).
- La suscripción de alertas no confirmada no avisa de nada: confirmarla.
- Si la cuenta tiene cuota de concurrencia 10, la reserva de 5 puede no ser
  posible (usar `orders_http_reserved_concurrency = null`, I-D4).
- El Budget de AWS tiene 8-24 h de atraso: por eso existe la alarma de
  flood, que corta en minutos.
- `ignore_changes` sobre `filename`/`source_code_hash`: `terraform apply`
  no despliega código; solo el workflow `Deploy` lo hace.
- `discord-retention` no existe (retirada; ADR-0020): no hay borrado
  automático.

## Rollback

Código: volver a `main` en el commit anterior y correr de nuevo el
workflow `Deploy` (no hay versiones publicadas ni alias). Infra: `git
revert` del cambio y `plan` + `apply` a mano; nunca `destroy` (la tabla
tiene `deletion_protection_enabled`).

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
