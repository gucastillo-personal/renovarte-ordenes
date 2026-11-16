locals {
  # Nombres físicos. Los comparten los recursos y las env vars de las
  # Lambdas: nacen de acá (no de referencias a los recursos) para que no
  # haya ciclos ni divergencias de nombre (plan.md I-D3).
  table_name = "${var.project_name}-datos"

  orders_http_name  = "${var.project_name}-orders-http"
  budget_guard_name = "${var.project_name}-budget-guard"
  orders_http_logs  = "/aws/lambda/${local.orders_http_name}"
  budget_guard_logs = "/aws/lambda/${local.budget_guard_name}"

  # Parámetros SSM (nombres, nunca valores; los crea I8).
  hmac_secret_param_name     = "/${var.project_name}/hmac-secret"
  discord_webhook_param_name = "/${var.project_name}/discord-webhook-url"

  # Los usan I9 (aws_budgets_budget), I10 (alarma de flood) y las env vars
  # de budget-guard.
  flood_alarm_name = "${var.project_name}-flood"
  budget_name      = "${var.project_name}-mensual"

  # alerts_email cae a budget_notification_email si no se define.
  alerts_email = coalesce(var.alerts_email, var.budget_notification_email)

  # Cuenta sin reserva posible (I-D4 caso b): null -> sin reserva (-1) y
  # ORDERS_HTTP_RESERVED_CONCURRENCY vacía (budget-guard hace Delete en
  # el reset).
  orders_http_reserved_concurrency_effective = var.orders_http_reserved_concurrency == null ? -1 : var.orders_http_reserved_concurrency
  orders_http_reserved_concurrency_env       = var.orders_http_reserved_concurrency == null ? "" : tostring(var.orders_http_reserved_concurrency)

  # --- PENDIENTE I7 (iam.tf) ---------------------------------------------
  # Los roles de ejecución los crea I7. Hasta entonces se reciben por
  # variable. Al llegar I7: reemplazar por aws_iam_role.orders_http.arn /
  # aws_iam_role.budget_guard.arn y borrar las dos variables.
  orders_http_role_arn  = var.orders_http_role_arn
  budget_guard_role_arn = var.budget_guard_role_arn
}
