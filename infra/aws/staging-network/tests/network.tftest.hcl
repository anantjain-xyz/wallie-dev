# Keep computed resource attributes unknown during plan: generating mock empty
# collections here would hide removal of explicit route = [] configuration.
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

run "network_configuration" {
  command = plan

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
    error_message = "All six non-public subnets must explicitly manage no non-local routes."
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
}

run "reject_invalid_account" {
  command = plan
  variables {
    aws_account_id = "12345"
  }
  expect_failures = [var.aws_account_id]
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
