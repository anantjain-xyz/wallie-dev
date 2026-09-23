variable "enable_self_hosted_supabase_connectivity" {
  description = "Reserve narrow application-to-Supabase and Supabase-to-Postgres paths for the isolated staging stack."
  type        = bool
  default     = false
  nullable    = false

  validation {
    condition     = !var.enable_self_hosted_supabase_connectivity || var.enable_private_connectivity
    error_message = "Self-hosted Supabase connectivity requires enable_private_connectivity = true."
  }
}

locals {
  supabase_tags = { Component = "self-hosted-supabase" }
}

# Attach this alongside the existing application task group to the web and
# worker. It adds only an internal gateway path; the original group's rules
# for private AWS endpoints remain unchanged.
resource "aws_security_group" "supabase_client" {
  count = var.enable_self_hosted_supabase_connectivity ? 1 : 0

  name        = "wallie-staging-supabase-client"
  description = "Web and worker access to the private Supabase API gateway"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.supabase_tags, { Name = "wallie-staging-supabase-client" })

  lifecycle {
    prevent_destroy = true
  }
}

# Attach this to the future private Supabase API task. Its only network path
# at this stage is gateway ingress from Wallie and Postgres egress.
resource "aws_security_group" "supabase_api" {
  count = var.enable_self_hosted_supabase_connectivity ? 1 : 0

  name        = "wallie-staging-supabase-api"
  description = "Private Supabase API gateway and database access"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.supabase_tags, { Name = "wallie-staging-supabase-api" })

  lifecycle {
    prevent_destroy = true
  }
}

# Attach this to the future PostgreSQL EC2 instance in database-a. No public
# address, inbound admin port, or general outbound path is introduced here.
resource "aws_security_group" "supabase_db" {
  count = var.enable_self_hosted_supabase_connectivity ? 1 : 0

  name        = "wallie-staging-supabase-db"
  description = "PostgreSQL access only from the private Supabase API task"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.supabase_tags, { Name = "wallie-staging-supabase-db" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "supabase_client_api" {
  count                        = var.enable_self_hosted_supabase_connectivity ? 1 : 0
  security_group_id            = aws_security_group.supabase_client[0].id
  referenced_security_group_id = aws_security_group.supabase_api[0].id
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
  description                  = "Private Supabase API gateway"
  tags                         = merge(local.supabase_tags, { Name = "wallie-staging-supabase-client-api" })
}

resource "aws_vpc_security_group_ingress_rule" "supabase_api_client" {
  count                        = var.enable_self_hosted_supabase_connectivity ? 1 : 0
  security_group_id            = aws_security_group.supabase_api[0].id
  referenced_security_group_id = aws_security_group.supabase_client[0].id
  ip_protocol                  = "tcp"
  from_port                    = 8000
  to_port                      = 8000
  description                  = "Private gateway requests from Wallie"
  tags                         = merge(local.supabase_tags, { Name = "wallie-staging-supabase-api-client" })
}

resource "aws_vpc_security_group_egress_rule" "supabase_api_db" {
  count                        = var.enable_self_hosted_supabase_connectivity ? 1 : 0
  security_group_id            = aws_security_group.supabase_api[0].id
  referenced_security_group_id = aws_security_group.supabase_db[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from private Supabase APIs"
  tags                         = merge(local.supabase_tags, { Name = "wallie-staging-supabase-api-db" })
}

resource "aws_vpc_security_group_ingress_rule" "supabase_db_api" {
  count                        = var.enable_self_hosted_supabase_connectivity ? 1 : 0
  security_group_id            = aws_security_group.supabase_db[0].id
  referenced_security_group_id = aws_security_group.supabase_api[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL from private Supabase APIs"
  tags                         = merge(local.supabase_tags, { Name = "wallie-staging-supabase-db-api" })
}

output "self_hosted_supabase_connectivity" {
  description = "Private security groups and planned first-AZ placement; no database or API compute is created."
  value = var.enable_self_hosted_supabase_connectivity ? {
    client_security_group_id = aws_security_group.supabase_client[0].id
    api_security_group_id    = aws_security_group.supabase_api[0].id
    db_security_group_id     = aws_security_group.supabase_db[0].id
    api_subnet_id            = aws_subnet.tier["services-a"].id
    db_subnet_id             = aws_subnet.tier["database-a"].id
  } : null
}
