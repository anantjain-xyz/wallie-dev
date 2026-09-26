variable "enable_postgres_session_logging" {
  description = "Permit the private PostgreSQL host to write Session Manager transcripts to its dedicated CloudWatch Logs group."
  type        = bool
  default     = false
  nullable    = false

  validation {
    condition = !var.enable_postgres_session_logging || (
      var.enable_private_connectivity && var.enable_self_hosted_supabase_connectivity
    )
    error_message = "PostgreSQL session logging requires private connectivity and the self-hosted Supabase database group."
  }
}

locals {
  postgres_session_logging_enabled = (
    var.enable_postgres_session_logging &&
    var.enable_private_connectivity &&
    var.enable_self_hosted_supabase_connectivity
  )
  postgres_session_logs_endpoint_condition = {
    ArnEquals = {
      "aws:PrincipalArn" = "arn:aws:iam::${var.aws_account_id}:role/wallie-staging-postgres"
    }
    StringEquals = {
      "aws:PrincipalAccount" = var.aws_account_id
      "aws:RequestedRegion"  = var.aws_region
    }
  }
  postgres_session_logging_tags = { Component = "postgres-session-logging" }
}

# The application's endpoint group also fronts ECR. Attach this distinct group
# only to Logs so the database host cannot reach ECR through its logging path.
resource "aws_security_group" "postgres_logs_endpoints" {
  count = local.postgres_session_logging_enabled ? 1 : 0

  name        = "wallie-staging-postgres-logs-endpoints"
  description = "Private Logs endpoint for staging PostgreSQL Session Manager transcripts"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.postgres_session_logging_tags, { Name = "wallie-staging-postgres-logs-endpoints" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "postgres_logs_endpoint_https" {
  count = local.postgres_session_logging_enabled ? 1 : 0

  security_group_id            = aws_security_group.postgres_logs_endpoints[0].id
  referenced_security_group_id = aws_security_group.supabase_db[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the PostgreSQL host to the private Logs endpoint"
  tags                         = merge(local.postgres_session_logging_tags, { Name = "wallie-staging-postgres-logs-ingress" })
}

resource "aws_vpc_security_group_egress_rule" "postgres_logs_https" {
  count = local.postgres_session_logging_enabled ? 1 : 0

  security_group_id            = aws_security_group.supabase_db[0].id
  referenced_security_group_id = aws_security_group.postgres_logs_endpoints[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the PostgreSQL host to the private Logs endpoint"
  tags                         = merge(local.postgres_session_logging_tags, { Name = "wallie-staging-postgres-logs-egress" })
}

output "postgres_session_logging" {
  description = "Private PostgreSQL Session Manager transcript path metadata for live readback."
  value = local.postgres_session_logging_enabled ? {
    database_security_group_id      = aws_security_group.supabase_db[0].id
    logs_endpoint_security_group_id = aws_security_group.postgres_logs_endpoints[0].id
    logs_endpoint_id                = aws_vpc_endpoint.application["logs"].id
  } : null
}
