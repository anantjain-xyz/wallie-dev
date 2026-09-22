# Keep computed resource attributes unknown during plan: generating mock empty
# collections here would hide removal of explicit empty routes or security rules.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/network-test"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-west-2a", "us-west-2b"]
    }
  }
}

variables {
  aws_account_id     = "123456789012"
  aws_region         = "us-west-2"
  availability_zones = ["us-west-2a", "us-west-2b"]
}

# The one-time bootstrap has its own mock state so the full-plan security
# assertions below still evaluate newly configured resources.
run "foundation_bootstrap" {
  command   = apply
  state_key = "foundation_bootstrap"

  plan_options {
    target = [aws_route_table_association.tier]
  }

  assert {
    condition = (
      output.default_security_group_id == aws_vpc.main.default_security_group_id &&
      output.default_network_acl_id == aws_vpc.main.default_network_acl_id &&
      length(output.default_security_group_id) > 0 &&
      length(output.default_network_acl_id) > 0
    )
    error_message = "Foundation bootstrap must expose the VPC defaults before hardening adoption."
  }
}

run "network_configuration" {
  command = plan

  assert {
    condition = (
      length(aws_vpc_endpoint.application) == 0 &&
      length(aws_vpc_endpoint.image_layers) == 0 &&
      length(aws_security_group.application_tasks) == 0 &&
      length(aws_security_group.aws_endpoints) == 0 &&
      length(aws_vpc_security_group_ingress_rule.endpoint_https) == 0 &&
      length(aws_vpc_security_group_egress_rule.task_endpoints_https) == 0 &&
      length(aws_vpc_security_group_egress_rule.task_s3_https) == 0 &&
      output.application_connectivity == null
    )
    error_message = "Existing foundation/hardening plans must add no paid endpoint or application rule without explicit opt-in."
  }

  assert {
    condition = (
      aws_vpc.main.cidr_block == "10.42.0.0/16" &&
      aws_vpc.main.enable_dns_support &&
      aws_vpc.main.enable_dns_hostnames &&
      !aws_vpc.main.assign_generated_ipv6_cidr_block
    )
    error_message = "The staging VPC must use the selected IPv4 range and enable DNS."
  }

  assert {
    condition = {
      for key, subnet in aws_subnet.tier : key => subnet.cidr_block
      } == {
      public-a   = "10.42.0.0/24"
      public-b   = "10.42.1.0/24"
      services-a = "10.42.16.0/24"
      services-b = "10.42.17.0/24"
      database-a = "10.42.32.0/24"
      database-b = "10.42.33.0/24"
      sandbox-a  = "10.42.48.0/24"
      sandbox-b  = "10.42.49.0/24"
    }
    error_message = "Each tier must reserve two distinct /24 ranges in stable AZ slots."
  }

  assert {
    condition = alltrue([
      for key, subnet in aws_subnet.tier :
      !subnet.map_public_ip_on_launch &&
      !subnet.assign_ipv6_address_on_creation &&
      subnet.availability_zone == (endswith(key, "-a") ? "us-west-2a" : "us-west-2b")
    ])
    error_message = "Every subnet must use its explicit AZ and disable automatic public IPs."
  }

  assert {
    condition = (
      toset(keys(aws_route_table.private)) == toset([
        "services-a", "services-b", "database-a", "database-b", "sandbox-a", "sandbox-b"
      ]) &&
      alltrue([for table in aws_route_table.private : length(table.route) == 0])
    )
    error_message = "All six non-public subnets must manage no ordinary non-local routes; S3 endpoint routes are managed separately."
  }

  assert {
    condition = (
      toset(keys(aws_route_table.public)) == toset(["public-a", "public-b"]) &&
      alltrue([
        for table in aws_route_table.public :
        length(table.route) == 1 && one(table.route).cidr_block == "0.0.0.0/0"
      ])
    )
    error_message = "Only the two public route tables may have a default IPv4 route."
  }

  assert {
    condition = (
      length(aws_default_security_group.main.ingress) == 0 &&
      length(aws_default_security_group.main.egress) == 0
    )
    error_message = "The VPC default security group must explicitly permit no ingress or egress."
  }

  assert {
    condition = (
      length(aws_network_acl.sandbox.ingress) == 0 &&
      length(aws_network_acl.sandbox.egress) == 0
    )
    error_message = "The reserved sandbox ACL must explicitly permit no ingress or egress."
  }
}

run "private_connectivity_policy" {
  command = plan
  variables {
    enable_private_connectivity = true
  }

  assert {
    condition = (
      toset(keys(aws_vpc_endpoint.application)) == toset(["ecr.api", "ecr.dkr", "logs"]) &&
      alltrue([for name, endpoint in aws_vpc_endpoint.application :
        endpoint.vpc_endpoint_type == "Interface" &&
        endpoint.service_name == "com.amazonaws.us-west-2.${name}" &&
        endpoint.ip_address_type == "ipv4" &&
        endpoint.private_dns_enabled
      ]) &&
      aws_vpc_endpoint.image_layers[0].vpc_endpoint_type == "Gateway" &&
      aws_vpc_endpoint.image_layers[0].service_name == "com.amazonaws.us-west-2.s3"
    )
    error_message = "Only the three named private IPv4 interface endpoints and S3 gateway may be configured."
  }

  assert {
    condition = alltrue([for name in ["ecr.api", "ecr.dkr"] :
      jsondecode(aws_vpc_endpoint.application[name].policy) == {
        Version = "2012-10-17"
        Statement = [
          {
            Sid       = "AuthenticateExpectedAccount"
            Effect    = "Allow"
            Principal = "*"
            Action    = "ecr:GetAuthorizationToken"
            Resource  = "*"
            Condition = { StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" } }
          },
          {
            Sid       = "PullApplicationImages"
            Effect    = "Allow"
            Principal = "*"
            Action    = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
            Resource  = ["arn:aws:ecr:us-west-2:123456789012:repository/wallie-staging/web", "arn:aws:ecr:us-west-2:123456789012:repository/wallie-staging/worker"]
            Condition = { StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" } }
          },
        ]
      }
    ])
    error_message = "ECR endpoints must allow only authentication and pulls from the exact application repositories in the expected account/region."
  }

  assert {
    condition = jsondecode(aws_vpc_endpoint.application["logs"].policy) == {
      Version = "2012-10-17"
      Statement = [{
        Sid       = "WriteApplicationLogs"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource  = ["arn:aws:logs:us-west-2:123456789012:log-group:/wallie/staging/web:log-stream:*", "arn:aws:logs:us-west-2:123456789012:log-group:/wallie/staging/worker:log-stream:*"]
        Condition = { StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" } }
      }]
    }
    error_message = "The Logs endpoint must permit only stream creation and writes in the two pre-existing log groups."
  }

  assert {
    condition = jsondecode(aws_vpc_endpoint.image_layers[0].policy) == {
      Version = "2012-10-17"
      Statement = [{
        Sid       = "ReadRegionalEcrImageLayers"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "arn:aws:s3:::prod-us-west-2-starport-layer-bucket/*"
      }]
    }
    error_message = "The cross-account S3 exception must permit only object reads from AWS's regional ECR layer bucket."
  }

  assert {
    condition = alltrue([for rule in [
      aws_vpc_security_group_ingress_rule.endpoint_https[0],
      aws_vpc_security_group_egress_rule.task_endpoints_https[0],
      aws_vpc_security_group_egress_rule.task_s3_https[0],
      ] :
      rule.ip_protocol == "tcp" && rule.from_port == 443 && rule.to_port == 443 &&
      rule.cidr_ipv4 == null && rule.cidr_ipv6 == null &&
      rule.tags.Component == "private-connectivity"
    ])
    error_message = "Every managed application rule must use TCP443 with an SG or S3-prefix-list destination/source, never a CIDR."
  }
}

# This apply uses the mocked provider above, never AWS. Generated IDs allow
# checking the actual graph edges instead of manufacturing IDs in fixtures.
run "subnet_and_route_associations" {
  command = apply

  assert {
    condition = (
      toset(keys(aws_route_table_association.tier)) == toset(keys(aws_subnet.tier)) &&
      alltrue([
        for key, association in aws_route_table_association.tier :
        association.subnet_id == aws_subnet.tier[key].id &&
        association.route_table_id == merge(aws_route_table.public, aws_route_table.private)[key].id
      ])
    )
    error_message = "Every subnet must have an explicit association to its own route table."
  }

  assert {
    condition = (
      aws_internet_gateway.main.vpc_id == aws_vpc.main.id &&
      alltrue([for subnet in aws_subnet.tier : subnet.vpc_id == aws_vpc.main.id]) &&
      alltrue([
        for table in merge(aws_route_table.public, aws_route_table.private) :
        table.vpc_id == aws_vpc.main.id
      ]) &&
      alltrue([
        for table in aws_route_table.public :
        one(table.route).gateway_id == aws_internet_gateway.main.id
      ])
    )
    error_message = "All network resources must belong to the new VPC and use its internet gateway."
  }

  assert {
    condition = (
      aws_default_security_group.main.vpc_id == aws_vpc.main.id &&
      aws_network_acl.sandbox.vpc_id == aws_vpc.main.id
    )
    error_message = "Both security controls must belong to this module's VPC."
  }

  assert {
    condition = (
      toset(keys(aws_network_acl_association.sandbox)) == toset(["sandbox-a", "sandbox-b"]) &&
      alltrue([
        for key, association in aws_network_acl_association.sandbox :
        association.subnet_id == aws_subnet.tier[key].id &&
        association.network_acl_id == aws_network_acl.sandbox.id
      ])
    )
    error_message = "The deny-all ACL must attach to exactly the two sandbox subnets and no other tier."
  }


}

run "private_connectivity_associations" {
  command   = apply
  state_key = "private_connectivity"
  variables {
    enable_private_connectivity = true
  }

  assert {
    condition = (
      aws_security_group.application_tasks[0].vpc_id == aws_vpc.main.id &&
      aws_security_group.aws_endpoints[0].vpc_id == aws_vpc.main.id &&
      aws_security_group.application_tasks[0].id != aws_security_group.aws_endpoints[0].id &&
      alltrue([for endpoint in aws_vpc_endpoint.application :
        endpoint.vpc_id == aws_vpc.main.id &&
        endpoint.subnet_ids == toset([aws_subnet.tier["services-a"].id, aws_subnet.tier["services-b"].id]) &&
        endpoint.security_group_ids == toset([aws_security_group.aws_endpoints[0].id])
      ]) &&
      aws_vpc_endpoint.image_layers[0].vpc_id == aws_vpc.main.id &&
      aws_vpc_endpoint.image_layers[0].route_table_ids == toset([
        aws_route_table.private["services-a"].id, aws_route_table.private["services-b"].id
      ])
    )
    error_message = "Endpoints and dedicated groups must use only the staging VPC and its services pair, never sandbox/database/public subnets or default SG."
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.endpoint_https[0].security_group_id == aws_security_group.aws_endpoints[0].id &&
      aws_vpc_security_group_ingress_rule.endpoint_https[0].referenced_security_group_id == aws_security_group.application_tasks[0].id &&
      aws_vpc_security_group_egress_rule.task_endpoints_https[0].security_group_id == aws_security_group.application_tasks[0].id &&
      aws_vpc_security_group_egress_rule.task_endpoints_https[0].referenced_security_group_id == aws_security_group.aws_endpoints[0].id &&
      aws_vpc_security_group_egress_rule.task_s3_https[0].security_group_id == aws_security_group.application_tasks[0].id &&
      aws_vpc_security_group_egress_rule.task_s3_https[0].prefix_list_id == aws_vpc_endpoint.image_layers[0].prefix_list_id
    )
    error_message = "Application traffic must use only the dedicated SG relationship and the S3 endpoint's own prefix list."
  }
}

run "reject_invalid_account" {
  command = plan
  variables {
    aws_account_id = "12345"
  }
  expect_failures = [var.aws_account_id]
}

run "reject_connectivity_outside_commercial_partition" {
  command = plan
  variables {
    enable_private_connectivity = true
    aws_region                  = "cn-north-1"
    availability_zones          = ["cn-north-1a", "cn-north-1b"]
  }
  override_data {
    target = data.aws_availability_zones.available
    values = { names = ["cn-north-1a", "cn-north-1b"] }
  }
  expect_failures = [aws_vpc_endpoint.image_layers[0]]
}

run "reject_invalid_region" {
  command = plan
  variables {
    aws_region         = "us_west_2"
    availability_zones = ["us_west_2a", "us_west_2b"]
  }
  expect_failures = [var.aws_region]
}

run "reject_one_az" {
  command = plan
  variables {
    availability_zones = ["us-west-2a"]
  }
  expect_failures = [var.availability_zones]
}

run "reject_three_azs" {
  command = plan
  variables {
    availability_zones = ["us-west-2a", "us-west-2b", "us-west-2c"]
  }
  expect_failures = [var.availability_zones]
}

run "reject_duplicate_azs" {
  command = plan
  variables {
    availability_zones = ["us-west-2a", "us-west-2a"]
  }
  expect_failures = [var.availability_zones]
}

run "reject_wrong_region_azs" {
  command = plan
  variables {
    availability_zones = ["us-east-1a", "us-east-1b"]
  }
  expect_failures = [var.availability_zones]
}

run "reject_local_zone" {
  command = plan
  variables {
    availability_zones = ["us-west-2a", "us-west-2-lax-1a"]
  }
  expect_failures = [var.availability_zones]
}

run "reject_unavailable_az" {
  command = plan
  variables {
    availability_zones = ["us-west-2a", "us-west-2c"]
  }
  expect_failures = [aws_vpc.main]
}

run "reject_public_cidr" {
  command = plan
  variables {
    vpc_cidr = "8.8.0.0/16"
  }
  expect_failures = [var.vpc_cidr]
}

run "reject_unaligned_cidr" {
  command = plan
  variables {
    vpc_cidr = "10.42.1.0/16"
  }
  expect_failures = [var.vpc_cidr]
}

run "reject_wrong_prefix" {
  command = plan
  variables {
    vpc_cidr = "10.42.0.0/24"
  }
  expect_failures = [var.vpc_cidr]
}

run "reject_malformed_cidr" {
  command = plan
  variables {
    vpc_cidr = "10.invalid"
  }
  expect_failures = [var.vpc_cidr]
}

run "reject_wrong_caller_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "999999999999"
      arn        = "arn:aws:iam::999999999999:user/network-test"
    }
  }
  expect_failures = [aws_vpc.main]
}

run "reject_root_caller" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
    }
  }
  expect_failures = [aws_vpc.main]
}
