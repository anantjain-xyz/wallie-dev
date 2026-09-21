locals {
  availability_zones = zipmap(["a", "b"], var.availability_zones)
  tier_offsets = {
    public   = 0
    services = 16
    database = 32
    sandbox  = 48
  }
  subnets = merge([
    for tier, offset in local.tier_offsets : {
      for slot, zone in local.availability_zones : "${tier}-${slot}" => {
        tier              = tier
        availability_zone = zone
        cidr_block        = cidrsubnet(var.vpc_cidr, 8, offset + (slot == "a" ? 0 : 1))
      }
    }
  ]...)
  public_subnets  = { for key, subnet in local.subnets : key => subnet if subnet.tier == "public" }
  private_subnets = { for key, subnet in local.subnets : key => subnet if subnet.tier != "public" }
  route_table_ids = merge(
    { for key, table in aws_route_table.public : key => table.id },
    { for key, table in aws_route_table.private : key => table.id }
  )
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "zone-type"
    values = ["availability-zone"]
  }
}

resource "aws_vpc" "main" {
  cidr_block                       = var.vpc_cidr
  enable_dns_support               = true
  enable_dns_hostnames             = true
  assign_generated_ipv6_cidr_block = false

  tags = {
    Name = "wallie-staging"
  }

  lifecycle {
    precondition {
      condition = (
        data.aws_caller_identity.current.account_id == var.aws_account_id &&
        !endswith(data.aws_caller_identity.current.arn, ":root")
      )
      error_message = "Use a non-root AWS identity in the expected aws_account_id."
    }

    precondition {
      condition     = alltrue([for zone in var.availability_zones : contains(data.aws_availability_zones.available.names, zone)])
      error_message = "Both requested Availability Zones must be available to this account in aws_region."
    }
  }
}

resource "aws_subnet" "tier" {
  for_each = local.subnets

  vpc_id                          = aws_vpc.main.id
  availability_zone               = each.value.availability_zone
  cidr_block                      = each.value.cidr_block
  map_public_ip_on_launch         = false
  assign_ipv6_address_on_creation = false

  tags = {
    Name = "wallie-staging-${each.key}"
    Tier = each.value.tier
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "wallie-staging"
  }
}

resource "aws_route_table" "public" {
  for_each = local.public_subnets

  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "wallie-staging-${each.key}"
    Tier = "public"
  }
}

resource "aws_route_table" "private" {
  for_each = local.private_subnets

  vpc_id = aws_vpc.main.id
  # Explicitly manage an empty set of non-local routes; omission would leave them unmanaged.
  route = []

  tags = {
    Name = "wallie-staging-${each.key}"
    Tier = each.value.tier
  }
}

resource "aws_route_table_association" "tier" {
  for_each = local.subnets

  subnet_id      = aws_subnet.tier[each.key].id
  route_table_id = local.route_table_ids[each.key]
}
