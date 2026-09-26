variable "enable_postgres_image_pull" {
  description = "Allow the private PostgreSQL host to pull only its mirrored image through ECR and the regional ECR S3 layer bucket."
  type        = bool
  default     = false
  nullable    = false

  validation {
    condition = !var.enable_postgres_image_pull || (
      var.enable_private_connectivity && var.enable_self_hosted_supabase_connectivity
    )
    error_message = "PostgreSQL image pulls require private connectivity and the self-hosted Supabase database group."
  }
}

locals {
  postgres_image_pull_enabled = (
    var.enable_postgres_image_pull &&
    var.enable_private_connectivity &&
    var.enable_self_hosted_supabase_connectivity
  )
}

# The existing endpoint group also fronts Logs. A separate group on only the
# ECR endpoints keeps the database host unable to reach the Logs endpoint.
resource "aws_security_group" "postgres_ecr_endpoints" {
  count = local.postgres_image_pull_enabled ? 1 : 0

  name        = "wallie-staging-postgres-ecr-endpoints"
  description = "Private ECR endpoints for the staging PostgreSQL host"
  vpc_id      = aws_vpc.main.id
  tags = {
    Component = "postgres-image-pull"
    Name      = "wallie-staging-postgres-ecr-endpoints"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "postgres_ecr_endpoint_https" {
  count = local.postgres_image_pull_enabled ? 1 : 0

  security_group_id            = aws_security_group.postgres_ecr_endpoints[0].id
  referenced_security_group_id = aws_security_group.supabase_db[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the PostgreSQL host to private ECR endpoints"
  tags = {
    Component = "postgres-image-pull"
    Name      = "wallie-staging-postgres-ecr-ingress"
  }
}

resource "aws_vpc_security_group_egress_rule" "postgres_ecr_https" {
  count = local.postgres_image_pull_enabled ? 1 : 0

  security_group_id            = aws_security_group.supabase_db[0].id
  referenced_security_group_id = aws_security_group.postgres_ecr_endpoints[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from the PostgreSQL host to private ECR endpoints"
  tags = {
    Component = "postgres-image-pull"
    Name      = "wallie-staging-postgres-ecr-egress"
  }
}

resource "aws_vpc_security_group_egress_rule" "postgres_ecr_layers_https" {
  count = local.postgres_image_pull_enabled ? 1 : 0

  security_group_id = aws_security_group.supabase_db[0].id
  prefix_list_id    = aws_vpc_endpoint.image_layers[0].prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to the regional ECR image-layer bucket through the S3 gateway"
  tags = {
    Component = "postgres-image-pull"
    Name      = "wallie-staging-postgres-ecr-layers"
  }
}

output "postgres_image_pull" {
  description = "Private PostgreSQL image path metadata for live readback; no runtime or credentials."
  value = local.postgres_image_pull_enabled ? {
    database_security_group_id     = aws_security_group.supabase_db[0].id
    ecr_endpoint_security_group_id = aws_security_group.postgres_ecr_endpoints[0].id
    ecr_api_endpoint_id            = aws_vpc_endpoint.application["ecr.api"].id
    ecr_dkr_endpoint_id            = aws_vpc_endpoint.application["ecr.dkr"].id
    ecr_layer_s3_endpoint_id       = aws_vpc_endpoint.image_layers[0].id
    database_route_table_id        = aws_route_table.private["database-a"].id
  } : null
}
