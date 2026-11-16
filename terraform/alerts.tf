# I-D13 (reducida): alertas operativas. Topic SNS SEPARADO del kill-switch
# (budget.tf): un canal caído no tiene que apagar el servicio, y el email
# del flood se suma acá sin que budget-guard reciba nada de este topic.
# Cuenta de alarmas del proyecto: 2 (flood en alarm.tf + canal-degradado),
# de las 10 gratis (I1 verificó 0 en uso). Los emails de alarma no llevan
# datos personales: CloudWatch manda nombre, métrica y umbral, no el log.

locals {
  alerts_metric_namespace  = "RenovArte/Ordenes"
  canal_fallido_metric     = "canal-fallido"
  canal_degradado_alarm_nm = "${var.project_name}-canal-degradado"
}

# Sin KMS: con la clave aws/sns CloudWatch no puede publicar.
resource "aws_sns_topic" "alertas_operativas" {
  name = "${var.project_name}-alertas-operativas"
}

data "aws_iam_policy_document" "alertas_operativas_topic" {
  statement {
    sid       = "PublicarCloudWatch"
    effect    = "Allow"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alertas_operativas.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alertas_operativas" {
  arn    = aws_sns_topic.alertas_operativas.arn
  policy = data.aws_iam_policy_document.alertas_operativas_topic.json
}

# La suscripción queda "pendiente de confirmación" hasta que el CTO/CEO
# hace clic en el mail de AWS (I15 paso 5).
resource "aws_sns_topic_subscription" "alertas_operativas_email" {
  topic_arn = aws_sns_topic.alertas_operativas.arn
  protocol  = "email"
  endpoint  = local.alerts_email
}

# Una sola custom metric: sin dimensiones. Depende de que el backend emita
# la línea JSON `{"evento":"canal_fallido",...}` (lib/log.ts, B16/B22).
resource "aws_cloudwatch_log_metric_filter" "canal_fallido" {
  name           = local.canal_fallido_metric
  log_group_name = aws_cloudwatch_log_group.orders_http.name
  pattern        = "{ $.evento = \"canal_fallido\" }"

  metric_transformation {
    name      = local.canal_fallido_metric
    namespace = local.alerts_metric_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "canal_degradado" {
  alarm_name          = local.canal_degradado_alarm_nm
  alarm_description   = "Un canal de entrega (mail o Discord) no entregó una orden. No apaga el servicio; ver runbook, incidente canal_fallido."
  namespace           = local.alerts_metric_namespace
  metric_name         = aws_cloudwatch_log_metric_filter.canal_fallido.metric_transformation[0].name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alertas_operativas.arn]

  depends_on = [aws_sns_topic_policy.alertas_operativas]
}

output "alertas_operativas_topic_arn" {
  description = "ARN del topic de alertas operativas (el CTO/CEO confirma la suscripción email tras el primer apply)."
  value       = aws_sns_topic.alertas_operativas.arn
}
