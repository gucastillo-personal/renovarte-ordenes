# Roles de ejecución de las Lambdas (I-D3, I-D5, I-D6, I-D7, I-D9).
# Mínimo privilegio: sin logs:CreateLogGroup (los log groups los crea
# Terraform), DynamoDB acotado por prefijo de clave y SES/SSM/Lambda por ARN.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  # ARNs construidos desde nombres (no desde los recursos) para no crear
  # ciclos con los roles.
  orders_http_arn  = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.orders_http_name}"
  budget_guard_arn = "arn:${data.aws_partition.current.partition}:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${local.budget_guard_name}"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

# --- orders-http -------------------------------------------------------------
resource "aws_iam_role" "orders_http" {
  name               = local.orders_http_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "orders_http" {
  statement {
    sid       = "LogsPropioGroup"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.orders_http.arn}:*"]
  }

  # I-D5. Sin DeleteItem (IDEM# ya no se libera). Las claves son IDEM#,
  # NUM#, RL#, CUPO#, LEDGER# y CONTROL (CONTROL solo lo lee en la
  # práctica). TransactWriteItems se autoriza con estas mismas acciones.
  statement {
    sid       = "DynamoPorPrefijo"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.datos.arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["IDEM#*", "NUM#*", "RL#*", "CUPO#*", "LEDGER#*", "CONTROL"]
    }
  }

  # I-D7: destinatario y remitente fijos. `Null ses:Recipients = false`
  # evita la "vacuous truth" de ForAllValues con la clave ausente.
  statement {
    sid       = "SesEnvioAcotado"
    effect    = "Allow"
    actions   = ["ses:SendEmail"]
    resources = local.ses_identity_arns
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "ses:Recipients"
      values   = [var.order_recipient_email]
    }
    condition {
      test     = "Null"
      variable = "ses:Recipients"
      values   = ["false"]
    }
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.order_sender_email]
    }
  }

  # I-D9: los dos parámetros (HMAC y webhook). Sin kms:Decrypt explícito
  # (clave aws/ssm; se valida en el smoke).
  statement {
    sid     = "SsmSecretos"
    effect  = "Allow"
    actions = ["ssm:GetParameter"]
    resources = [
      aws_ssm_parameter.hmac_secret.arn,
      aws_ssm_parameter.discord_webhook_url.arn,
    ]
  }
}

resource "aws_iam_role_policy" "orders_http" {
  name   = "permisos"
  role   = aws_iam_role.orders_http.id
  policy = data.aws_iam_policy_document.orders_http.json
}

# --- budget-guard ------------------------------------------------------------
resource "aws_iam_role" "budget_guard" {
  name               = local.budget_guard_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "budget_guard" {
  statement {
    sid       = "LogsPropioGroup"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.budget_guard.arn}:*"]
  }

  # I-D5: solo la clave CONTROL (kill-switch).
  statement {
    sid       = "DynamoSoloControl"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.datos.arn]
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "dynamodb:LeadingKeys"
      values   = ["CONTROL"]
    }
  }

  # I-D6: apagar/reactivar orders-http por concurrency; solo su ARN.
  statement {
    sid    = "ConcurrencyOrdersHttp"
    effect = "Allow"
    actions = [
      "lambda:PutFunctionConcurrency",
      "lambda:DeleteFunctionConcurrency",
      "lambda:GetFunctionConcurrency",
    ]
    resources = [local.orders_http_arn]
  }
}

resource "aws_iam_role_policy" "budget_guard" {
  name   = "permisos"
  role   = aws_iam_role.budget_guard.id
  policy = data.aws_iam_policy_document.budget_guard.json
}
