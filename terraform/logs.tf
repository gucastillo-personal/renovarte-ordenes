# Log groups creados por Terraform ANTES que las funciones: los roles no
# tienen logs:CreateLogGroup, solo CreateLogStream/PutLogEvents sobre su
# propio group (I-D3). Retención de 14 días (el costo de logs queda acotado).
resource "aws_cloudwatch_log_group" "orders_http" {
  name              = local.orders_http_logs
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "budget_guard" {
  name              = local.budget_guard_logs
  retention_in_days = 14
}
