# Un solo zip compartido por todas las Lambdas (I-D3), producido por
# `pnpm build` (tsc -> dist/, sin bundler; @aws-sdk/* viene en el runtime
# nodejs22.x). `archive_file` necesita dist/ en `plan`/`apply`, no en
# `validate`.
data "archive_file" "ordenes_dist" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/build/ordenes.zip"
}

resource "aws_lambda_function" "orders_http" {
  function_name    = local.orders_http_name
  role             = local.orders_http_role_arn # PENDIENTE I7: aws_iam_role.orders_http.arn
  handler          = "handlers/index.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  filename         = data.archive_file.ordenes_dist.output_path
  source_code_hash = data.archive_file.ordenes_dist.output_base64sha256
  timeout          = 10
  memory_size      = 256

  # I-D4: reserva = techo estructural; null -> sin reserva (-1).
  reserved_concurrent_executions = local.orders_http_reserved_concurrency_effective

  # Text (default), no JSON de Lambda: los metric filters (I-D13) necesitan
  # la línea JSON cruda que escribe el logger del backend.
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.orders_http.name
  }

  environment {
    variables = {
      ORDER_RECIPIENT_EMAIL    = var.order_recipient_email
      ORDER_SENDER_EMAIL       = var.order_sender_email
      CATALOG_PRODUCTS_URL     = var.catalog_products_url
      ALLOWED_ORIGINS          = join(",", var.allowed_origins)
      ORDERS_TABLE             = aws_dynamodb_table.datos.name
      HMAC_SECRET_PARAM        = local.hmac_secret_param_name     # nombre, no valor
      DISCORD_WEBHOOK_PARAM    = local.discord_webhook_param_name # nombre, no valor
      CONFIG_REVISION          = tostring(var.config_revision)
      BUDGET_CAP_USD           = tostring(var.budget_cap_usd)
      BUDGET_STOP_RATIO        = tostring(var.budget_stop_ratio)
      COSTO_REQUEST_USD        = tostring(var.costo_request_usd)
      COSTO_MAIL_USD           = tostring(var.costo_mail_usd)
      RL_POST_POR_HORA_IP      = tostring(var.rl_post_por_hora_ip)
      RL_ACEPTADAS_POR_HORA_IP = tostring(var.rl_aceptadas_por_hora_ip)
      RL_ACEPTADAS_POR_DIA_IP  = tostring(var.rl_aceptadas_por_dia_ip)
      CUPO_ORDENES_DIA         = tostring(var.cupo_ordenes_dia)
      CUPO_ORDENES_MES         = tostring(var.cupo_ordenes_mes)
    }
  }

  depends_on = [aws_cloudwatch_log_group.orders_http]

  lifecycle {
    # reserved_concurrent_executions: un apply con el kill-switch activo no
    # la vuelve a 5 en silencio (I-D4). filename/source_code_hash: el código
    # se despliega por el workflow OIDC (I-D10), no por Terraform.
    ignore_changes = [reserved_concurrent_executions, filename, source_code_hash]
  }
}

resource "aws_lambda_function" "budget_guard" {
  function_name    = local.budget_guard_name
  role             = local.budget_guard_role_arn # PENDIENTE I7: aws_iam_role.budget_guard.arn
  handler          = "handlers/budget-guard.handler"
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  filename         = data.archive_file.ordenes_dist.output_path
  source_code_hash = data.archive_file.ordenes_dist.output_base64sha256
  timeout          = 10
  memory_size      = 128

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.budget_guard.name
  }

  environment {
    variables = {
      ORDERS_TABLE                     = aws_dynamodb_table.datos.name
      ORDERS_HTTP_FUNCTION_NAME        = local.orders_http_name # de locals: evita ciclos
      ORDERS_HTTP_RESERVED_CONCURRENCY = local.orders_http_reserved_concurrency_env
      FLOOD_ALARM_NAME                 = local.flood_alarm_name
      BUDGET_NAME                      = local.budget_name
    }
  }

  depends_on = [aws_cloudwatch_log_group.budget_guard]

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }
}
