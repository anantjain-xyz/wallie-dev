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

run "default_is_unbilled_and_isolated" {
  command = plan

  assert {
    condition = (
      length(aws_eip.runtime_egress) == 0 &&
      length(aws_nat_gateway.runtime_egress) == 0 &&
      length(aws_security_group.runtime_egress) == 0 &&
      length(aws_vpc_security_group_egress_rule.runtime_https) == 0 &&
      alltrue([for table in aws_route_table.private : length(table.route) == 0]) &&
      output.runtime_https_egress == null
    )
    error_message = "Omitting runtime HTTPS egress must add no paid IP/NAT, SG, rule, or private default route."
  }
}

run "requires_private_connectivity" {
  command = plan

  variables {
    enable_runtime_https_egress = true
  }

  expect_failures = [var.enable_runtime_https_egress]
}

run "only_services_a_uses_same_az_nat" {
  command   = apply
  state_key = "runtime_https_egress"

  variables {
    enable_private_connectivity = true
    enable_runtime_https_egress = true
  }

  assert {
    condition = (
      length(aws_eip.runtime_egress) == 1 &&
      length(aws_nat_gateway.runtime_egress) == 1 &&
      aws_eip.runtime_egress[0].domain == "vpc" &&
      aws_nat_gateway.runtime_egress[0].connectivity_type == "public" &&
      aws_nat_gateway.runtime_egress[0].allocation_id == aws_eip.runtime_egress[0].id &&
      aws_nat_gateway.runtime_egress[0].subnet_id == aws_subnet.tier["public-a"].id &&
      aws_subnet.tier["public-a"].availability_zone == aws_subnet.tier["services-a"].availability_zone &&
      length(aws_route_table.private["services-a"].route) == 1 &&
      one(aws_route_table.private["services-a"].route).cidr_block == "0.0.0.0/0" &&
      one(aws_route_table.private["services-a"].route).nat_gateway_id == aws_nat_gateway.runtime_egress[0].id &&
      alltrue([for key, table in aws_route_table.private : key == "services-a" || length(table.route) == 0])
    )
    error_message = "Only services-a may route through the NAT in public-a; all other private tiers remain isolated."
  }

  assert {
    condition = (
      length(aws_security_group.runtime_egress) == 1 &&
      length(aws_vpc_security_group_egress_rule.runtime_https) == 1 &&
      length(aws_security_group.runtime_egress[0].ingress) == 0 &&
      length(aws_security_group.runtime_egress[0].egress) == 0 &&
      aws_vpc_security_group_egress_rule.runtime_https[0].security_group_id == aws_security_group.runtime_egress[0].id &&
      aws_vpc_security_group_egress_rule.runtime_https[0].cidr_ipv4 == "0.0.0.0/0" &&
      aws_vpc_security_group_egress_rule.runtime_https[0].cidr_ipv6 == null &&
      aws_vpc_security_group_egress_rule.runtime_https[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.runtime_https[0].from_port == 443 &&
      aws_vpc_security_group_egress_rule.runtime_https[0].to_port == 443 &&
      length(aws_vpc_security_group_egress_rule.task_endpoints_https) == 1 &&
      length(aws_vpc_security_group_egress_rule.task_s3_https) == 1
    )
    error_message = "The separate runtime group must add exactly one outbound IPv4 HTTPS rule and zero ingress; existing task rules remain."
  }

  assert {
    condition = (
      output.runtime_https_egress.nat_gateway_id == aws_nat_gateway.runtime_egress[0].id &&
      output.runtime_https_egress.services_subnet_id == aws_subnet.tier["services-a"].id &&
      output.runtime_https_egress.task_security_group_ids == [
        aws_security_group.application_tasks[0].id,
        aws_security_group.runtime_egress[0].id
      ]
    )
    error_message = "Task deployment output must pair the existing private SG with the new egress SG in services-a."
  }
}
