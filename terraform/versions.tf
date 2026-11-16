terraform {
  # >= 1.11 por los atributos write-only (`value_wo`) del parámetro SSM
  # (I-D9): el valor del secreto nunca se guarda en el estado.
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # >= 6.28: `invoked_via_function_url` en aws_lambda_permission (I-D1).
      version = "~> 6.28"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}
