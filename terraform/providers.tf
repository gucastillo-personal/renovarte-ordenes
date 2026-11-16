# default_tags a nivel de provider: todos los recursos de este repo llevan
# Project=renovarte-ordenes. El AWS Budget (I-D6) filtra por este tag y no
# toca los recursos de las otras specs.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project = "renovarte-ordenes"
    }
  }
}
