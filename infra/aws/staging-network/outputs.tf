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

output "application_connectivity" {
  description = "Private image/log connectivity for later application tasks; no workloads are launched."
  value = var.enable_private_connectivity ? {
    task_security_group_id     = aws_security_group.application_tasks[0].id
    endpoint_security_group_id = aws_security_group.aws_endpoints[0].id
    interface_endpoints = {
      for name, endpoint in aws_vpc_endpoint.application : name => {
        id                    = endpoint.id
        subnet_ids            = endpoint.subnet_ids
        network_interface_ids = endpoint.network_interface_ids
      }
    }
    s3_endpoint_id    = aws_vpc_endpoint.image_layers[0].id
    s3_prefix_list_id = aws_vpc_endpoint.image_layers[0].prefix_list_id
  } : null
}

output "runtime_https_egress" {
  description = "Opt-in one-AZ outbound HTTPS path for real tasks in services-a."
  value = var.enable_runtime_https_egress ? {
    nat_gateway_id          = aws_nat_gateway.runtime_egress[0].id
    eip_allocation_id       = aws_eip.runtime_egress[0].allocation_id
    public_subnet_id        = aws_subnet.tier["public-a"].id
    services_subnet_id      = aws_subnet.tier["services-a"].id
    services_route_table_id = aws_route_table.private["services-a"].id
    task_security_group_ids = [
      aws_security_group.application_tasks[0].id,
      aws_security_group.runtime_egress[0].id,
    ]
  } : null
}
