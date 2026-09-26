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
      length(aws_security_group.postgres_ecr_endpoints) == 0 &&
      length(aws_vpc_security_group_ingress_rule.postgres_ecr_endpoint_https) == 0 &&
      length(aws_vpc_security_group_egress_rule.postgres_ecr_https) == 0 &&
      length(aws_vpc_security_group_egress_rule.postgres_ecr_layers_https) == 0 &&
      alltrue([for endpoint in aws_vpc_endpoint.application :
        endpoint.security_group_ids == toset([aws_security_group.aws_endpoints[0].id])
      ]) &&
      alltrue([for name in ["ecr.api", "ecr.dkr"] :
        length(jsondecode(aws_vpc_endpoint.application[name].policy).Statement) == 2
      ]) &&
      aws_vpc_endpoint.image_layers[0].route_table_ids == toset([
        aws_route_table.private["services-a"].id,
        aws_route_table.private["services-b"].id,
      ]) &&
      output.postgres_image_pull == null
    )
    error_message = "Existing private and Supabase connectivity must gain no PostgreSQL image path without opt-in."
  }
}

run "requires_private_connectivity" {
  command = plan

  variables {
    enable_postgres_image_pull = true
  }

  expect_failures = [var.enable_postgres_image_pull]
}

run "requires_supabase_database_group" {
  command = plan

  variables {
    enable_private_connectivity = true
    enable_postgres_image_pull  = true
  }

  expect_failures = [var.enable_postgres_image_pull]
}

run "postgres_uses_only_private_ecr_and_image_layers" {
  command   = apply
  state_key = "postgres_image_pull"

  variables {
    enable_private_connectivity              = true
    enable_self_hosted_supabase_connectivity = true
    enable_postgres_image_pull               = true
  }

  assert {
    condition = (
      length(aws_security_group.postgres_ecr_endpoints) == 1 &&
      aws_security_group.postgres_ecr_endpoints[0].vpc_id == aws_vpc.main.id &&
      aws_security_group.postgres_ecr_endpoints[0].tags.Component == "postgres-image-pull" &&
      length(aws_security_group.postgres_ecr_endpoints[0].ingress) == 0 &&
      length(aws_security_group.postgres_ecr_endpoints[0].egress) == 0 &&
      toset(keys(aws_vpc_endpoint.application)) == toset(["ecr.api", "ecr.dkr", "logs"]) &&
      alltrue([for name in ["ecr.api", "ecr.dkr"] :
        aws_vpc_endpoint.application[name].security_group_ids == toset([
          aws_security_group.aws_endpoints[0].id,
          aws_security_group.postgres_ecr_endpoints[0].id,
        ]) &&
        aws_vpc_endpoint.application[name].subnet_ids == toset([
          aws_subnet.tier["services-a"].id,
          aws_subnet.tier["services-b"].id,
        ]) &&
        aws_vpc_endpoint.application[name].private_dns_enabled
      ]) &&
      aws_vpc_endpoint.application["logs"].security_group_ids == toset([
        aws_security_group.aws_endpoints[0].id,
      ])
    )
    error_message = "Add only a dedicated database SG on the existing private ECR endpoints; Logs must keep its original group."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.postgres_ecr_endpoint_https[0].security_group_id == aws_security_group.postgres_ecr_endpoints[0].id &&
      aws_vpc_security_group_ingress_rule.postgres_ecr_endpoint_https[0].referenced_security_group_id == aws_security_group.supabase_db[0].id &&
      aws_vpc_security_group_egress_rule.postgres_ecr_https[0].security_group_id == aws_security_group.supabase_db[0].id &&
      aws_vpc_security_group_egress_rule.postgres_ecr_https[0].referenced_security_group_id == aws_security_group.postgres_ecr_endpoints[0].id &&
      aws_vpc_security_group_egress_rule.postgres_ecr_layers_https[0].security_group_id == aws_security_group.supabase_db[0].id &&
      aws_vpc_security_group_egress_rule.postgres_ecr_layers_https[0].prefix_list_id == aws_vpc_endpoint.image_layers[0].prefix_list_id &&
      alltrue([for rule in [
        aws_vpc_security_group_ingress_rule.postgres_ecr_endpoint_https[0],
        aws_vpc_security_group_egress_rule.postgres_ecr_https[0],
        aws_vpc_security_group_egress_rule.postgres_ecr_layers_https[0],
        ] :
        rule.ip_protocol == "tcp" && rule.from_port == 443 && rule.to_port == 443 &&
        rule.cidr_ipv4 == null && rule.cidr_ipv6 == null &&
        rule.tags.Component == "postgres-image-pull"
      ])
    )
    error_message = "Database image traffic must use SG-referenced ECR HTTPS and the existing S3 prefix list only."
  }

  assert {
    condition = (
      aws_vpc_endpoint.image_layers[0].route_table_ids == toset([
        aws_route_table.private["services-a"].id,
        aws_route_table.private["services-b"].id,
        aws_route_table.private["database-a"].id,
      ]) &&
      length(aws_route_table.private["database-a"].route) == 0 &&
      length(aws_nat_gateway.runtime_egress) == 0 &&
      jsondecode(aws_vpc_endpoint.image_layers[0].policy).Statement[0].Resource == "arn:aws:s3:::prod-us-west-2-starport-layer-bucket/*"
    )
    error_message = "Only database-a gains the regional ECR layer route; it must retain no default Internet route."
  }

  assert {
    condition = alltrue([for name in ["ecr.api", "ecr.dkr"] :
      length(jsondecode(aws_vpc_endpoint.application[name].policy).Statement) == 3 &&
      jsondecode(aws_vpc_endpoint.application[name].policy).Statement[1].Resource == [
        "arn:aws:ecr:us-west-2:123456789012:repository/wallie-staging/web",
        "arn:aws:ecr:us-west-2:123456789012:repository/wallie-staging/worker",
      ] &&
      jsondecode(aws_vpc_endpoint.application[name].policy).Statement[2] == {
        Sid       = "PullPostgresImage"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
        Resource  = "arn:aws:ecr:us-west-2:123456789012:repository/wallie-staging/supabase-postgres"
        Condition = {
          ArnEquals = {
            "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/wallie-staging-postgres"
          }
          StringEquals = {
            "aws:PrincipalAccount" = "123456789012"
            "aws:RequestedRegion"  = "us-west-2"
          }
        }
      }
    ])
    error_message = "ECR endpoints must add only the exact PostgreSQL repository for the exact host role."
  }

  assert {
    condition = output.postgres_image_pull == {
      database_security_group_id     = aws_security_group.supabase_db[0].id
      ecr_endpoint_security_group_id = aws_security_group.postgres_ecr_endpoints[0].id
      ecr_api_endpoint_id            = aws_vpc_endpoint.application["ecr.api"].id
      ecr_dkr_endpoint_id            = aws_vpc_endpoint.application["ecr.dkr"].id
      ecr_layer_s3_endpoint_id       = aws_vpc_endpoint.image_layers[0].id
      database_route_table_id        = aws_route_table.private["database-a"].id
    }
    error_message = "Expose only the DB image path's network IDs for a later live readback."
  }
}
