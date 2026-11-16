# I-D10: rol de deploy del código por OIDC. El proveedor OIDC de GitHub es
# un singleton de la cuenta: NO se crea acá, llega por
# var.github_oidc_provider_arn. El rol solo actualiza el código de las dos
# Lambdas; no toca IAM, env vars, concurrency ni SSM.

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Solo este repo y solo la rama main.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${var.project_name}-github-deploy-role"
  assume_role_policy = data.aws_iam_policy_document.github_deploy_assume.json
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid    = "DeployCodigoLambdas"
    effect = "Allow"
    actions = [
      "lambda:UpdateFunctionCode",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
    ]
    resources = [local.orders_http_arn, local.budget_guard_arn]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy-codigo"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

output "github_deploy_role_arn" {
  description = "ARN del rol de deploy: va como VARIABLE (no secreto) del repo en GitHub, usada por deploy.yml."
  value       = aws_iam_role.github_deploy.arn
}
