# I-D7: SES v2 en sandbox. Opción A (default): identidad de email para el
# destinatario; en sandbox esa misma identidad hace de remitente y
# destinatario (hay que hacer clic en el mail de verificación, vence a las
# 24 h). Opción B (var.sender_domain != ""): identidad de dominio con Easy
# DKIM y MAIL FROM propio; los registros DNS (DKIM, MX/SPF de MAIL FROM y
# DMARC p=none) se cargan a mano en el registrador, no en Route 53.
# No se pide acceso de producción.

locals {
  use_sender_domain = var.sender_domain != ""

  # El remitente necesita su propia identidad solo si difiere del
  # destinatario y no se usa un dominio propio (opción A).
  create_sender_identity = !local.use_sender_domain && var.order_sender_email != var.order_recipient_email
}

resource "aws_sesv2_email_identity" "recipient" {
  email_identity = var.order_recipient_email
}

resource "aws_sesv2_email_identity" "sender" {
  count          = local.create_sender_identity ? 1 : 0
  email_identity = var.order_sender_email
}

# --- Opción B ---------------------------------------------------------------
resource "aws_sesv2_email_identity" "domain" {
  count          = local.use_sender_domain ? 1 : 0
  email_identity = var.sender_domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  count                  = local.use_sender_domain ? 1 : 0
  email_identity         = aws_sesv2_email_identity.domain[0].email_identity
  mail_from_domain       = "mail.${var.sender_domain}"
  behavior_on_mx_failure = "USE_DEFAULT_MAIL_FROM"
}

locals {
  # ARNs de las identidades desde las que/hacia las que puede enviar el rol.
  ses_identity_arns = concat(
    [aws_sesv2_email_identity.recipient.arn],
    aws_sesv2_email_identity.sender[*].arn,
    aws_sesv2_email_identity.domain[*].arn,
  )
}

output "ses_dkim_tokens" {
  description = "Opción B: tokens DKIM (CNAME <token>._domainkey.<dominio> -> <token>.dkim.amazonses.com). Vacío en la opción A."
  value       = local.use_sender_domain ? aws_sesv2_email_identity.domain[0].dkim_signing_attributes[0].tokens : []
}
