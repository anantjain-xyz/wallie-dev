output "vpc_id" {
  description = "ID of the new staging VPC."
  value       = aws_vpc.main.id
}

output "vpc_cidr" {
  description = "Staging VPC IPv4 range."
  value       = aws_vpc.main.cidr_block
}

output "subnets" {
  description = "Reserved /24 subnets and their route tables, keyed by tier and stable AZ slot."
  value = {
    for key, subnet in aws_subnet.tier : key => {
      id                = subnet.id
      tier              = local.subnets[key].tier
      availability_zone = subnet.availability_zone
      cidr_block        = subnet.cidr_block
      route_table_id    = local.route_table_ids[key]
    }
  }
}

output "internet_gateway_id" {
  description = "Internet gateway used only by the public subnet route tables."
  value       = aws_internet_gateway.main.id
}

output "default_security_group_id" {
  description = "This VPC's default security group; available before its empty-rule adoption."
  value       = aws_vpc.main.default_security_group_id
}

output "default_network_acl_id" {
  description = "This VPC's unchanged default ACL, used when removing sandbox ACL associations."
  value       = aws_vpc.main.default_network_acl_id
}

output "sandbox_network_acl_id" {
  description = "Custom ACL with no allow rules, assigned only to the empty sandbox reservations."
  value       = aws_network_acl.sandbox.id
}

output "sandbox_network_acl_associations" {
  description = "Sandbox ACL associations, keyed by tier and stable AZ slot."
  value = {
    for key, association in aws_network_acl_association.sandbox : key => {
      id             = association.id
      subnet_id      = association.subnet_id
      network_acl_id = association.network_acl_id
    }
  }
}
