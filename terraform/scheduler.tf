# I-D6: reset mensual del kill-switch (día 1, 00:00 UTC) -> budget-guard con
# {"mode":"reset"}. Un solo rol de Scheduler, con lambda:InvokeFunction solo
# sobre budget-guard (el schedule de discord-retention se retiró, I19).

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.project_name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "InvocarBudgetGuard"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.budget_guard_arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "permisos"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "budget_reset" {
  name                         = "${var.project_name}-budget-reset"
  schedule_expression          = "cron(0 0 1 * ? *)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.budget_guard.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ mode = "reset" })
  }
}
