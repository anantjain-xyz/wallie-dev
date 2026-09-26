mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/network-test"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b"] }
  }
}

variables {
  aws_account_id     = "123456789012"
  aws_region         = "us-west-2"
  availability_zones = ["us-west-2a", "us-west-2b"]
}

run "disabled_in_existing_private_plan" {
  command   = apply
  state_key = "disabled"

  variables {
    enable_private_connectivity              = true
    enable_self_hosted_supabase_connectivity = true
  }

  assert {
    condition = (
      length(aws_security_group.postgres_logs_endpoints) == 0 &&
      length(aws_vpc_security_group_ingress_rule.postgres_logs_endpoint_https) == 0 &&
      length(aws_vpc_security_group_egress_rule.postgres_logs_https) == 0 &&
      aws_vpc_endpoint.application["logs"].security_group_ids == toset([aws_security_group.aws_endpoints[0].id]) &&
      length(jsondecode(aws_vpc_endpoint.application["logs"].policy).Statement) == 1 &&
      output.postgres_session_logging == null
    )
    error_message = "Existing private and Supabase connectivity must gain no database Logs path without opt-in."
  }
}

run "requires_private_connectivity" {
  command = plan

  variables {
    enable_postgres_session_logging = true
  }

  expect_failures = [var.enable_postgres_session_logging]
}

run "requires_supabase_database_group" {
  command = plan

  variables {
    enable_private_connectivity     = true
    enable_postgres_session_logging = true
  }

  expect_failures = [var.enable_postgres_session_logging]
}

run "private_postgres_logs_path" {
  command   = apply
  state_key = "postgres_session_logging"

  variables {
    enable_private_connectivity              = true
    enable_self_hosted_supabase_connectivity = true
    enable_postgres_session_logging          = true
  }

  assert {
    condition = (
      length(aws_security_group.postgres_logs_endpoints) == 1 &&
      aws_security_group.postgres_logs_endpoints[0].vpc_id == aws_vpc.main.id &&
      aws_security_group.postgres_logs_endpoints[0].tags.Component == "postgres-session-logging" &&
      length(aws_security_group.postgres_logs_endpoints[0].ingress) == 0 &&
      length(aws_security_group.postgres_logs_endpoints[0].egress) == 0 &&
      aws_vpc_endpoint.application["logs"].security_group_ids == toset([
        aws_security_group.aws_endpoints[0].id,
        aws_security_group.postgres_logs_endpoints[0].id,
      ]) &&
      alltrue([for name in ["ecr.api", "ecr.dkr"] :
        aws_vpc_endpoint.application[name].security_group_ids == toset([aws_security_group.aws_endpoints[0].id])
      ]) &&
      aws_vpc_endpoint.application["logs"].subnet_ids == toset([
        aws_subnet.tier["services-a"].id,
        aws_subnet.tier["services-b"].id,
      ]) &&
      length(aws_nat_gateway.runtime_egress) == 0 &&
      length(aws_route_table.private["database-a"].route) == 0 &&
      aws_vpc_endpoint.image_layers[0].route_table_ids == toset([
        aws_route_table.private["services-a"].id,
        aws_route_table.private["services-b"].id,
      ])
    )
    error_message = "The database must reach only the existing private Logs endpoint through a distinct SG, without adding ECR or Internet routes."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.postgres_logs_endpoint_https[0].security_group_id == aws_security_group.postgres_logs_endpoints[0].id &&
      aws_vpc_security_group_ingress_rule.postgres_logs_endpoint_https[0].referenced_security_group_id == aws_security_group.supabase_db[0].id &&
      aws_vpc_security_group_egress_rule.postgres_logs_https[0].security_group_id == aws_security_group.supabase_db[0].id &&
      aws_vpc_security_group_egress_rule.postgres_logs_https[0].referenced_security_group_id == aws_security_group.postgres_logs_endpoints[0].id &&
      alltrue([for rule in [
        aws_vpc_security_group_ingress_rule.postgres_logs_endpoint_https[0],
        aws_vpc_security_group_egress_rule.postgres_logs_https[0],
        ] :
        rule.ip_protocol == "tcp" && rule.from_port == 443 && rule.to_port == 443 &&
        rule.cidr_ipv4 == null && rule.cidr_ipv6 == null &&
        rule.tags.Component == "postgres-session-logging"
      ])
    )
    error_message = "The Logs path must have only paired SG-referenced TCP/443 rules."
  }

  assert {
    condition = (
      jsondecode(aws_vpc_endpoint.application["logs"].policy).Statement == [
        {
          Sid       = "WriteApplicationLogs"
          Effect    = "Allow"
          Principal = "*"
          Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource = [
            "arn:aws:logs:us-west-2:123456789012:log-group:/wallie/staging/web:log-stream:*",
            "arn:aws:logs:us-west-2:123456789012:log-group:/wallie/staging/worker:log-stream:*",
          ]
          Condition = { StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" } }
        },
        {
          Sid       = "DescribePostgresSessionLogGroups"
          Effect    = "Allow"
          Principal = "*"
          Action    = "logs:DescribeLogGroups"
          Resource  = "*"
          Condition = {
            ArnEquals    = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/wallie-staging-postgres" }
            StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" }
          }
        },
        {
          Sid       = "DescribePostgresSessionLogStreams"
          Effect    = "Allow"
          Principal = "*"
          Action    = "logs:DescribeLogStreams"
          Resource  = "arn:aws:logs:us-west-2:123456789012:log-group:/wallie/staging/postgres/session"
          Condition = {
            ArnEquals    = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/wallie-staging-postgres" }
            StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" }
          }
        },
        {
          Sid       = "WritePostgresSessionLogs"
          Effect    = "Allow"
          Principal = "*"
          Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
          Resource  = "arn:aws:logs:us-west-2:123456789012:log-group:/wallie/staging/postgres/session:log-stream:*"
          Condition = {
            ArnEquals    = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/wallie-staging-postgres" }
            StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" }
          }
        },
      ]
    )
    error_message = "The Logs endpoint must preserve app writes and grant only the exact host role's session transcript actions."
  }

  assert {
    condition = output.postgres_session_logging == {
      database_security_group_id      = aws_security_group.supabase_db[0].id
      logs_endpoint_security_group_id = aws_security_group.postgres_logs_endpoints[0].id
      logs_endpoint_id                = aws_vpc_endpoint.application["logs"].id
    }
    error_message = "Expose only the session transcript network IDs for live readback."
  }
}

run "image_pull_remains_separate" {
  command   = apply
  state_key = "both_postgres_paths"

  variables {
    enable_private_connectivity              = true
    enable_self_hosted_supabase_connectivity = true
    enable_postgres_image_pull               = true
    enable_postgres_session_logging          = true
  }

  assert {
    condition = (
      aws_vpc_endpoint.application["logs"].security_group_ids == toset([
        aws_security_group.aws_endpoints[0].id,
        aws_security_group.postgres_logs_endpoints[0].id,
      ]) &&
      alltrue([for name in ["ecr.api", "ecr.dkr"] :
        aws_vpc_endpoint.application[name].security_group_ids == toset([
          aws_security_group.aws_endpoints[0].id,
          aws_security_group.postgres_ecr_endpoints[0].id,
        ])
      ]) &&
      aws_security_group.postgres_logs_endpoints[0].id != aws_security_group.postgres_ecr_endpoints[0].id
    )
    error_message = "The simultaneous Logs and ECR paths must keep their endpoint groups separate."
  }
}
