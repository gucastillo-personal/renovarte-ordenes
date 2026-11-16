# I-D6: AWS Budget propio + topic SNS del kill-switch. Sin Budget Action
# (USD 0). Prerrequisito manual: tag `Project` activo como cost allocation
# tag (I1). Filtro solo por tag (Budgets combina filtros con AND).

resource "aws_budgets_budget" "mensual" {
  name         = local.budget_name
  budget_type  = "COST"
  limit_amount = tostring(var.aws_budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = ["user:Project$renovarte-ordenes"]
  }

  # 80 % ACTUAL: solo email.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
  }

  # 100 % ACTUAL: SNS (kill-switch) y además email.
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_notification_email]
    subscriber_sns_topic_arns  = [aws_sns_topic.kill_switch.arn]
  }

  depends_on = [aws_sns_topic_policy.kill_switch]
}

# Sin KMS: el mensaje no lleva datos personales y con aws/sns Budgets no
# puede publicar. Lo usan SOLO el Budget al 100 % y la alarma de flood.
resource "aws_sns_topic" "kill_switch" {
  name = "${var.project_name}-budget-alerts"
}

data "aws_iam_policy_document" "kill_switch_topic" {
  statement {
    sid       = "PublicarBudgetsYCloudWatch"
    effect    = "Allow"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.kill_switch.arn]
    principals {
      type        = "Service"
      identifiers = ["budgets.amazonaws.com", "cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "kill_switch" {
  arn    = aws_sns_topic.kill_switch.arn
  policy = data.aws_iam_policy_document.kill_switch_topic.json
}

resource "aws_sns_topic_subscription" "kill_switch_budget_guard" {
  topic_arn = aws_sns_topic.kill_switch.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.budget_guard.arn
}

resource "aws_lambda_permission" "budget_guard_sns" {
  statement_id  = "AllowInvokeFromKillSwitchTopic"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.budget_guard.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.kill_switch.arn
}
