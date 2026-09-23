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

run "disabled_by_default" {
  command = plan

  assert {
    condition = (
      length(aws_security_group.supabase_client) == 0 &&
      length(aws_security_group.supabase_api) == 0 &&
      length(aws_security_group.supabase_db) == 0 &&
      length(aws_vpc_security_group_egress_rule.supabase_client_api) == 0 &&
      length(aws_vpc_security_group_ingress_rule.supabase_api_client) == 0 &&
      length(aws_vpc_security_group_egress_rule.supabase_api_db) == 0 &&
      length(aws_vpc_security_group_ingress_rule.supabase_db_api) == 0 &&
      output.self_hosted_supabase_connectivity == null
    )
    error_message = "The existing network plan must not create Supabase groups or rules by default."
  }
}

run "requires_existing_private_task_connectivity" {
  command = plan

  variables {
    enable_self_hosted_supabase_connectivity = true
  }

  expect_failures = [var.enable_self_hosted_supabase_connectivity]
}

run "private_gateway_and_database_only" {
  command   = apply
  state_key = "supabase_connectivity"

  variables {
    enable_private_connectivity              = true
    enable_self_hosted_supabase_connectivity = true
  }

  assert {
    condition = (
      length(aws_security_group.supabase_client) == 1 &&
      length(aws_security_group.supabase_api) == 1 &&
      length(aws_security_group.supabase_db) == 1 &&
      alltrue([for group in [
        aws_security_group.supabase_client[0],
        aws_security_group.supabase_api[0],
        aws_security_group.supabase_db[0]
      ] : group.vpc_id == aws_vpc.main.id && length(group.ingress) == 0 && length(group.egress) == 0 && group.tags.Component == "self-hosted-supabase"]) &&
      length(aws_vpc_security_group_egress_rule.task_endpoints_https) == 1 &&
      length(aws_vpc_security_group_egress_rule.task_s3_https) == 1 &&
      length(aws_eip.runtime_egress) == 0 &&
      length(aws_nat_gateway.runtime_egress) == 0
    )
    error_message = "Create only dedicated groups, preserving existing task paths and no internet egress."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.supabase_client_api[0].security_group_id == aws_security_group.supabase_client[0].id &&
      aws_vpc_security_group_egress_rule.supabase_client_api[0].referenced_security_group_id == aws_security_group.supabase_api[0].id &&
      aws_vpc_security_group_ingress_rule.supabase_api_client[0].security_group_id == aws_security_group.supabase_api[0].id &&
      aws_vpc_security_group_ingress_rule.supabase_api_client[0].referenced_security_group_id == aws_security_group.supabase_client[0].id &&
      aws_vpc_security_group_egress_rule.supabase_api_db[0].security_group_id == aws_security_group.supabase_api[0].id &&
      aws_vpc_security_group_egress_rule.supabase_api_db[0].referenced_security_group_id == aws_security_group.supabase_db[0].id &&
      aws_vpc_security_group_ingress_rule.supabase_db_api[0].security_group_id == aws_security_group.supabase_db[0].id &&
      aws_vpc_security_group_ingress_rule.supabase_db_api[0].referenced_security_group_id == aws_security_group.supabase_api[0].id
    )
    error_message = "Allow only Wallie client to private API and private API to Postgres."
  }

  assert {
    condition = (
      alltrue([for rule in [
        aws_vpc_security_group_egress_rule.supabase_client_api[0],
        aws_vpc_security_group_ingress_rule.supabase_api_client[0]
      ] : rule.ip_protocol == "tcp" && rule.from_port == 8000 && rule.to_port == 8000 && rule.cidr_ipv4 == null && rule.cidr_ipv6 == null]) &&
      alltrue([for rule in [
        aws_vpc_security_group_egress_rule.supabase_api_db[0],
        aws_vpc_security_group_ingress_rule.supabase_db_api[0]
      ] : rule.ip_protocol == "tcp" && rule.from_port == 5432 && rule.to_port == 5432 && rule.cidr_ipv4 == null && rule.cidr_ipv6 == null])
    )
    error_message = "Gateway and database rules must use only exact TCP ports and SG references."
  }

  assert {
    condition = (
      output.self_hosted_supabase_connectivity.client_security_group_id == aws_security_group.supabase_client[0].id &&
      output.self_hosted_supabase_connectivity.api_security_group_id == aws_security_group.supabase_api[0].id &&
      output.self_hosted_supabase_connectivity.db_security_group_id == aws_security_group.supabase_db[0].id &&
      output.self_hosted_supabase_connectivity.api_subnet_id == aws_subnet.tier["services-a"].id &&
      output.self_hosted_supabase_connectivity.db_subnet_id == aws_subnet.tier["database-a"].id
    )
    error_message = "Expose only first-AZ private placement and the three dedicated group IDs."
  }
}
