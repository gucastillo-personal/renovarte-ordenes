# I-D8: alarma de flood sobre orders-http -> kill-switch. Con CONTROL
# apagado orders-http no escribe en el ledger; esta alarma corta en ~2-3
# min lo que el Budget (8-24 h de atraso) no ve. Sin ok_actions:
# budget-guard ignora OK y la reactivación es manual (o el día 1).
resource "aws_cloudwatch_metric_alarm" "flood" {
  alarm_name          = local.flood_alarm_name # = FLOOD_ALARM_NAME de budget-guard
  alarm_description   = "Invocaciones de orders-http por minuto sobre el umbral: apaga el servicio (kill-switch)."
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = var.flood_invocations_per_minute
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = local.orders_http_name
  }

  # PENDIENTE I18: agregar el topic de alertas operativas
  # (aws_sns_topic.alertas_operativas.arn) para que el CTO/CEO reciba un
  # email cuando el flood apaga el servicio.
  alarm_actions = [aws_sns_topic.kill_switch.arn]
}
