# I-D1: superficie HTTP = Function URL sin auth (la autenticación es el
# HMAC del payload + rate limit + reserved concurrency). BUFFERED.
resource "aws_lambda_function_url" "orders_http" {
  function_name      = aws_lambda_function.orders_http.function_name
  authorization_type = "NONE"
  invoke_mode        = "BUFFERED"

  # I-D2: CORS en la URL (el preflight no invoca el Lambda). El handler
  # NO emite Access-Control-* (headers duplicados rompen el navegador).
  cors {
    allow_origins     = var.allowed_origins
    allow_methods     = ["GET", "POST"]
    allow_headers     = ["content-type"]
    allow_credentials = false
    max_age           = 3600
  }
}

# Desde oct-2025 la URL pública exige los DOS permisos.
resource "aws_lambda_permission" "orders_http_url_invoke_url" {
  statement_id           = "AllowPublicInvokeFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.orders_http.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "orders_http_url_invoke" {
  statement_id  = "AllowPublicInvokeViaFunctionUrl"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.orders_http.function_name
  principal     = "*"
  # Sin esta condición el permiso habilitaría la API Invoke directa a
  # cualquier cuenta AWS: no omitir (I-D1).
  invoked_via_function_url = true
}

output "orders_api_url" {
  description = "URL base de la API de órdenes (la consume el catálogo como ORDERS_API_URL)."
  value       = aws_lambda_function_url.orders_http.function_url
}
