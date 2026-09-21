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
