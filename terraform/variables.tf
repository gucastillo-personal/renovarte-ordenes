variable "project_name" {
  description = "Prefijo de los nombres físicos de todos los recursos."
  type        = string
  default     = "renovarte-ordenes"
}

variable "aws_region" {
  description = "Región AWS (SES, Lambda y DynamoDB en la misma región)."
  type        = string
  default     = "us-east-1"
}

variable "order_recipient_email" {
  description = "Casilla que recibe las órdenes (ORDER_RECIPIENT_EMAIL; fija en IAM de SES, I-D7). Sin default: va en terraform.tfvars (gitignoreado); el repo es público."
  type        = string
}

variable "order_sender_email" {
  description = "Remitente verificado en SES (ORDER_SENDER_EMAIL). Sin default: va en terraform.tfvars."
  type        = string
}

variable "allowed_origins" {
  description = "Orígenes permitidos por CORS de la Function URL y por el chequeo de Origin del handler: solo el dominio de producción del catálogo. Sin previews ni comodines (I-D2)."
  type        = list(string)

  validation {
    condition     = length(var.allowed_origins) > 0 && alltrue([for o in var.allowed_origins : o != "*" && startswith(o, "https://")])
    error_message = "allowed_origins: al menos un origen https:// y sin '*' (I-D2)."
  }
}

variable "catalog_products_url" {
  description = "URL pública de products.json del catálogo (CATALOG_PRODUCTS_URL); el servicio re-verifica precios contra ella."
  type        = string
}

variable "orders_http_reserved_concurrency" {
  description = "Reserved concurrency de orders-http (techo estructural, I-D4). null = sin reserva (cuenta con cuota 10, I-D4 caso b). Cambiarla en producción también exige put-function-concurrency a mano (ignore_changes)."
  type        = number
  default     = 5
  nullable    = true
}

variable "aws_budget_limit_usd" {
  description = "Límite mensual del AWS Budget propio de este proyecto (I-D6; lo usa I9)."
  type        = number
  default     = 20
}

variable "budget_notification_email" {
  description = "Email de las notificaciones del AWS Budget. Sin default a propósito: va en terraform.tfvars."
  type        = string
}

variable "alerts_email" {
  description = "Email de las alertas operativas (topic SNS separado, I-D13). null = usa budget_notification_email."
  type        = string
  default     = null
}

variable "flood_invocations_per_minute" {
  description = "Umbral de la alarma de flood sobre orders-http (I-D8; lo usa I10)."
  type        = number
  default     = 300
}

variable "config_revision" {
  description = "Revisión de configuración: subirla tras rotar un secreto en SSM fuerza a las Lambdas calientes a releerlo (CONFIG_REVISION, I-D9)."
  type        = number
  default     = 1
}

variable "sender_domain" {
  description = "Dominio propio para SES (opción B de I-D7). Vacío = opción A (identidad de email)."
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "Repo GitHub 'owner/nombre' autorizado a asumir el rol de deploy por OIDC (I-D10; lo usa I13)."
  type        = string
}

variable "github_oidc_provider_arn" {
  description = "ARN del proveedor OIDC de GitHub ya existente en la cuenta (I-D10; lo usa I13). Va en terraform.tfvars."
  type        = string
}

# --- Umbrales de rate limit y cupos (RFC §6.3) -----------------------------
variable "rl_post_por_hora_ip" {
  description = "POST por IP por hora (RL_POST_POR_HORA_IP)."
  type        = number
  default     = 20
}

variable "rl_aceptadas_por_hora_ip" {
  description = "Órdenes aceptadas por IP por hora (RL_ACEPTADAS_POR_HORA_IP)."
  type        = number
  default     = 3
}

variable "rl_aceptadas_por_dia_ip" {
  description = "Órdenes aceptadas por IP por día (RL_ACEPTADAS_POR_DIA_IP)."
  type        = number
  default     = 10
}

variable "cupo_ordenes_dia" {
  description = "Cupo global de órdenes por día (CUPO_ORDENES_DIA)."
  type        = number
  default     = 50
}

variable "cupo_ordenes_mes" {
  description = "Cupo global de órdenes por mes (CUPO_ORDENES_MES)."
  type        = number
  default     = 1000
}

# --- Ledger propio (RFC §8.2) ----------------------------------------------
variable "budget_cap_usd" {
  description = "Tope mensual del ledger propio (BUDGET_CAP_USD)."
  type        = number
  default     = 20
}

variable "budget_stop_ratio" {
  description = "Fracción del tope a la que el ledger apaga el servicio (BUDGET_STOP_RATIO)."
  type        = number
  default     = 0.9
}

variable "costo_request_usd" {
  description = "Costo unitario conservador por request (COSTO_REQUEST_USD; x2 sobre la referencia)."
  type        = number
  default     = 0.00002
}

variable "costo_mail_usd" {
  description = "Costo unitario conservador por mail SES (COSTO_MAIL_USD; x2 sobre la referencia)."
  type        = number
  default     = 0.0002
}

# --- PENDIENTE I7 -----------------------------------------------------------
# TEMPORAL: I7 (iam.tf) crea los roles de ejecución; hasta entonces se
# reciben por variable. Se borran cuando I7 reemplace locals.*_role_arn.
variable "orders_http_role_arn" {
  description = "TEMPORAL (I7): ARN del rol de ejecución de orders-http."
  type        = string
  default     = null
}

variable "budget_guard_role_arn" {
  description = "TEMPORAL (I7): ARN del rol de ejecución de budget-guard."
  type        = string
  default     = null
}
