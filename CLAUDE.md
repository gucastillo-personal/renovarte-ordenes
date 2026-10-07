# Reglas de flujo de trabajo

Estas reglas aplican a cualquier sesión de Claude Code (o cualquier agente)
que trabaje en este repo, no solo a la sesión que las escribió. Es
submódulo de [`renovarte-parent`](https://github.com/gucastillo-personal/renovarte-parent)
y hereda además las invariantes cross-repo de su
[`specs/constitution.md`](https://github.com/gucastillo-personal/renovarte-parent/blob/main/specs/constitution.md).

## Qué es este repo

Servicio de órdenes de la spec
[`0017-carrito-orden-compra`](https://github.com/gucastillo-personal/renovarte-parent/blob/main/specs/0017-carrito-orden-compra/spec.md)
(cross-repo, vive en `renovarte-parent`). Responsabilidad única: recibir,
validar contra el catálogo publicado y entregar una orden por doble canal
(SES + webhook de Discord, ADR-0006/ADR-0016) con corte de gasto. No tiene
UI (eso es `renovarte-catalogo`). **Este repo es público.**

## Nunca commitear ni pushear directo a `main`

Ningún agente commitea ni pushea directo sobre `main` en este repo,
incluidos cambios "chicos" como docs o config. Todo trabajo arranca
creando una rama dedicada (`feature/<slug>`, `hotfix/<slug>`,
`chore/<slug>`, etc., la que corresponda al tipo de cambio) y llega a
`main` únicamente vía Pull Request. Es una regla de proceso, además de (no
en lugar de) la aprobación humana explícita que ya exige cada `git commit`
y cada `git push` más abajo.

## Nunca mergear Pull Requests

El merge final a `main` lo ejecuta siempre una persona humana, sin
excepción, aunque todos los checks requeridos estén en verde. No uses
`gh pr merge` ni equivalentes.

## Aprobación humana obligatoria antes de actuar

- Ningún agente puede instalar herramientas, paquetes o dependencias (npm,
  pnpm, pip, uv, aws cli, terraform, gh cli, etc.) ni ejecutar scripts que
  no sean de solo lectura, sin pedir aprobación humana explícita antes de
  hacerlo. Esto incluye `terraform init` (descarga providers) y
  `terraform apply`/`terraform destroy` (crean/destruyen recursos reales en
  AWS) — `terraform validate` y `terraform plan` son de solo lectura, pero
  igual requieren que `terraform init` haya corrido antes (con su propia
  aprobación).
- Antes de cada `git commit` y antes de cada `git push` hay que pedir
  aprobación humana explícita — no alcanza con que el humano haya aprobado
  la tarea en general; cada commit y cada push necesitan su propio ok.

## Secretos

El secreto HMAC y la URL del webhook de Discord viven en SSM Parameter
Store ([ADR-0019](https://github.com/gucastillo-personal/renovarte-parent/blob/main/docs/decisions/ADR-0019-secretos-en-ssm.md)):
nunca en el repo, en `.tfvars`, en variables de entorno, en el estado de
Terraform ni en el chat. Este repo es público: tampoco se commitean IDs de
cuenta AWS, ARNs reales ni IDs de Discord. `pnpm check:leak` lo audita en
cada CI run.

## Datos personales (ADR-0020)

Una orden lleva **nombre y apellido** y **teléfono** (`contacto`). Son
datos personales (Ley 25.326):

- Se procesan solo en memoria: **nunca** a DynamoDB, logs, métricas,
  mensajes de error ni respuestas.
- No se loguea ni se persiste el contacto, ni la URL del webhook de
  Discord, ni el cuerpo de las respuestas de Discord.
- Los logs usan una allowlist de campos.
- El asunto del email y la primera línea de Discord no llevan datos
  personales.
- La IP se guarda solo como `HMAC(secreto, ip)`, con TTL de 24 h; `IDEM#`
  seudonimizado, TTL de 90 días.
- No hay borrado automático en Discord ni Gmail (decisión del MVP);
  cualquier supresión es manual, a pedido (ver `docs/runbook.md`).
- Los datos de contacto no se publican ni se commitean, tampoco en tests ni
  fixtures (usar valores ficticios obviamente falsos).
- El `sessionStorage` del navegador no aplica acá: es de `renovarte-catalogo`.

## Invariante de negocio (constitution — aplica también acá)

Ningún costo, margen ni precio de lista LACA sale nunca de este repo hacia
el cliente. Los precios se validan contra el `products.json` publicado;
nunca se usan los que manda el cliente.
