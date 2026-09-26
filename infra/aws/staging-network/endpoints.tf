locals {
  service_subnets = { for key, subnet in aws_subnet.tier : key => subnet if startswith(key, "services-") }
  connectivity_tags = {
    Component = "private-connectivity"
  }
  endpoint_account_condition = {
    StringEquals = {
      "aws:PrincipalAccount" = var.aws_account_id
      "aws:RequestedRegion"  = var.aws_region
    }
  }
  ecr_endpoint_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid       = "AuthenticateExpectedAccount"
        Effect    = "Allow"
        Principal = "*"
        Action    = "ecr:GetAuthorizationToken"
        Resource  = "*"
        Condition = local.endpoint_account_condition
      },
      {
        Sid       = "PullApplicationImages"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource = [
          "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/wallie-staging/web",
          "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/wallie-staging/worker",
        ]
        Condition = local.endpoint_account_condition
      },
      ], local.postgres_image_pull_enabled ? [{
        Sid       = "PullPostgresImage"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource  = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/wallie-staging/supabase-postgres"
        Condition = {
          ArnEquals = {
            "aws:PrincipalArn" = "arn:aws:iam::${var.aws_account_id}:role/wallie-staging-postgres"
          }
          StringEquals = {
            "aws:PrincipalAccount" = var.aws_account_id
            "aws:RequestedRegion"  = var.aws_region
          }
        }
    }] : [])
  })
  logs_endpoint_policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([{
      Sid       = "WriteApplicationLogs"
      Effect    = "Allow"
      Principal = "*"
      Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
      Resource = [
        "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/wallie/staging/web:log-stream:*",
        "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/wallie/staging/worker:log-stream:*",
      ]
      Condition = local.endpoint_account_condition
      }], [for statement in [
      {
        Sid       = "DescribePostgresSessionLogGroups"
        Effect    = "Allow"
        Principal = "*"
        Action    = "logs:DescribeLogGroups"
        Resource  = "*"
        Condition = local.postgres_session_logs_endpoint_condition
      },
      {
        Sid       = "DescribePostgresSessionLogStreams"
        Effect    = "Allow"
        Principal = "*"
        Action    = "logs:DescribeLogStreams"
        Resource  = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/wallie/staging/postgres/session"
        Condition = local.postgres_session_logs_endpoint_condition
      },
      {
        Sid       = "WritePostgresSessionLogs"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource  = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:/wallie/staging/postgres/session:log-stream:*"
        Condition = local.postgres_session_logs_endpoint_condition
      },
    ] : statement if local.postgres_session_logging_enabled])
  })
  interface_endpoints = {
    "ecr.api" = local.ecr_endpoint_policy
    "ecr.dkr" = local.ecr_endpoint_policy
    "logs"    = local.logs_endpoint_policy
  }
}

# Standalone rules avoid a dependency cycle between the two security groups.
# The provider removes AWS's default allow-all egress when creating each group.
resource "aws_security_group" "application_tasks" {
  count = var.enable_private_connectivity ? 1 : 0

  name        = "wallie-staging-application-tasks"
  description = "Private application tasks: only HTTPS to AWS endpoints and ECR image layers"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.connectivity_tags, { Name = "wallie-staging-application-tasks" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_security_group" "aws_endpoints" {
  count = var.enable_private_connectivity ? 1 : 0

  name        = "wallie-staging-aws-endpoints"
  description = "Private AWS endpoints: HTTPS only from the application task security group"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.connectivity_tags, { Name = "wallie-staging-aws-endpoints" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_https" {
  count = var.enable_private_connectivity ? 1 : 0

  security_group_id            = aws_security_group.aws_endpoints[0].id
  referenced_security_group_id = aws_security_group.application_tasks[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS from application tasks"
  tags                         = merge(local.connectivity_tags, { Name = "wallie-staging-endpoint-https" })
}

resource "aws_vpc_security_group_egress_rule" "task_endpoints_https" {
  count = var.enable_private_connectivity ? 1 : 0

  security_group_id            = aws_security_group.application_tasks[0].id
  referenced_security_group_id = aws_security_group.aws_endpoints[0].id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "HTTPS to private AWS endpoints"
  tags                         = merge(local.connectivity_tags, { Name = "wallie-staging-task-endpoint-https" })
}

resource "aws_vpc_security_group_egress_rule" "task_s3_https" {
  count = var.enable_private_connectivity ? 1 : 0

  security_group_id = aws_security_group.application_tasks[0].id
  prefix_list_id    = aws_vpc_endpoint.image_layers[0].prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to S3; gateway endpoint policy permits only regional ECR image layers"
  tags              = merge(local.connectivity_tags, { Name = "wallie-staging-task-layer-https" })
}

resource "aws_vpc_endpoint" "application" {
  for_each = var.enable_private_connectivity ? local.interface_endpoints : {}

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  ip_address_type     = "ipv4"
  private_dns_enabled = true
  subnet_ids          = [for subnet in local.service_subnets : subnet.id]
  security_group_ids = concat(
    [aws_security_group.aws_endpoints[0].id],
    local.postgres_image_pull_enabled && each.key != "logs" ? aws_security_group.postgres_ecr_endpoints[*].id : [],
    local.postgres_session_logging_enabled && each.key == "logs" ? aws_security_group.postgres_logs_endpoints[*].id : []
  )
  policy = each.value
  tags   = merge(local.connectivity_tags, { Name = "wallie-staging-${replace(each.key, ".", "-")}" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_endpoint" "image_layers" {
  count = var.enable_private_connectivity ? 1 : 0

  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  ip_address_type   = "ipv4"
  route_table_ids = concat(
    [for key, subnet in local.service_subnets : aws_route_table.private[key].id],
    local.postgres_image_pull_enabled ? [aws_route_table.private["database-a"].id] : []
  )
  tags = merge(local.connectivity_tags, { Name = "wallie-staging-ecr-image-layers" })

  # ECR supplies presigned URLs using an AWS-owned principal/bucket. Requiring
  # our PrincipalAccount or ResourceAccount here would block image layer pulls.
  # https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "ReadRegionalEcrImageLayers"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "arn:aws:s3:::prod-${var.aws_region}-starport-layer-bucket/*"
    }]
  })

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = !startswith(var.aws_region, "cn-") && !startswith(var.aws_region, "us-gov-")
      error_message = "This private application connectivity configuration supports the commercial AWS partition only."
    }
  }
}
