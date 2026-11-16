# I-D9: secretos en SSM SecureString (clave aws/ssm, parámetros Standard:
# USD 0). `value_wo` es write-only: nunca se guarda en el estado ni en el
# plan, así que el repo y el state solo ven el placeholder. Terraform crea
# el parámetro y no lo vuelve a tocar mientras no cambie
# `value_wo_version`. El valor real lo carga el humano con
#   read -rs V; aws ssm put-parameter --name <nombre> --type SecureString \
#     --overwrite --value "$V"
# y luego sube var.config_revision (CONFIG_REVISION) y hace apply para
# que las Lambdas calientes lo relean. Requiere Terraform >= 1.11.
#
# Mientras quede el placeholder, orders-http falla la validación de host
# del webhook (RFC §6.1) y el canal Discord queda fallido/config (alerta
# canal_fallido): es el comportamiento buscado hasta cargar el real.

resource "aws_ssm_parameter" "hmac_secret" {
  name             = local.hmac_secret_param_name
  description      = "Secreto HMAC del payload de ordenes (valor real cargado a mano con put-parameter)."
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = "PLACEHOLDER-cargar-con-put-parameter"
  value_wo_version = 1
}

resource "aws_ssm_parameter" "discord_webhook_url" {
  name             = local.discord_webhook_param_name
  description      = "URL del webhook de Discord (valor real cargado a mano con put-parameter)."
  type             = "SecureString"
  tier             = "Standard"
  value_wo         = "PLACEHOLDER-cargar-con-put-parameter"
  value_wo_version = 1
}
