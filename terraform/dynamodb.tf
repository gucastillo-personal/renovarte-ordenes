# I-D5: una sola tabla on-demand. Claves: IDEM#, NUM#, RL#, CUPO#, LEDGER#,
# CONTROL, BORRAR#*. Sin streams ni PITR; cifrado por default.
resource "aws_dynamodb_table" "datos" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  # Epoch-segundos. NUM# y BORRAR#CURSOR no llevan expira_en (no expiran).
  ttl {
    attribute_name = "expira_en"
    enabled        = true
  }

  # Protege NUM# (correlativo de órdenes) y BORRAR#CURSOR, que no tienen TTL.
  deletion_protection_enabled = true
}
