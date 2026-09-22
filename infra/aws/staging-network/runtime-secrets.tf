variable "enable_runtime_secret_connectivity" {
  description = "Add the separately reviewed, billable Secrets Manager endpoint. Keep enabled after creation."
  type        = bool
  default     = false
  nullable    = false

  validation {
    condition     = !var.enable_runtime_secret_connectivity || var.enable_private_connectivity
    error_message = "Runtime secret connectivity requires enable_private_connectivity = true."
  }
}

variable "runtime_secret_arns" {
  description = "Exact existing web/worker runtime secret ARNs from application output; metadata only, never secret values."
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition = length(var.runtime_secret_arns) == 0 ? !var.enable_runtime_secret_connectivity : (
      toset(keys(var.runtime_secret_arns)) == toset(["web", "worker"]) &&
      alltrue([for component, arn in var.runtime_secret_arns : can(regex(
        "^arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:/wallie/staging/${component}/runtime-[A-Za-z0-9]{6}$", arn
      ))])
    )
    error_message = "Supply both full web/worker runtime secret ARNs in this account/region, each with its exact six-character AWS suffix; required when enabling connectivity."
  }
}

resource "aws_vpc_endpoint" "runtime_secrets" {
  count = var.enable_runtime_secret_connectivity ? 1 : 0

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.secretsmanager"
  vpc_endpoint_type   = "Interface"
  ip_address_type     = "ipv4"
  private_dns_enabled = true
  subnet_ids          = [for subnet in local.service_subnets : subnet.id]
  security_group_ids  = aws_security_group.aws_endpoints[*].id
  tags                = merge(local.connectivity_tags, { Name = "wallie-staging-runtime-secrets" })

  # Separate statements keep each execution role bound to its own full ARN.
  # PrincipalArn matches the role behind an assumed-role session. This endpoint
  # policy does not grant identity permissions or allow secret writes.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [for component, arn in var.runtime_secret_arns : {
      Sid       = "Read${title(component)}RuntimeSecret"
      Effect    = "Allow"
      Principal = "*"
      Action    = "secretsmanager:GetSecretValue"
      Resource  = arn
      Condition = {
        ArnEquals = {
          "aws:PrincipalArn" = "arn:aws:iam::${var.aws_account_id}:role/wallie-staging-${component}-execution"
        }
        StringEquals = {
          "aws:PrincipalAccount" = var.aws_account_id
          "aws:RequestedRegion"  = var.aws_region
        }
      }
    }]
  })

  lifecycle {
    prevent_destroy = true
  }
}

output "runtime_secret_connectivity" {
  description = "Separate private Secrets Manager endpoint; existing application_connectivity output remains image/log-only."
  value = var.enable_runtime_secret_connectivity ? {
    id                    = aws_vpc_endpoint.runtime_secrets[0].id
    subnet_ids            = aws_vpc_endpoint.runtime_secrets[0].subnet_ids
    security_group_ids    = aws_vpc_endpoint.runtime_secrets[0].security_group_ids
    network_interface_ids = aws_vpc_endpoint.runtime_secrets[0].network_interface_ids
    runtime_secret_arns   = var.runtime_secret_arns
  } : null
}
