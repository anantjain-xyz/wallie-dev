variable "enable_runtime_https_egress" {
  description = "Create one zonal public NAT for outbound HTTPS from private services-a tasks. Keep enabled after creation."
  type        = bool
  default     = false
  nullable    = false

  validation {
    condition     = !var.enable_runtime_https_egress || var.enable_private_connectivity
    error_message = "Runtime HTTPS egress requires enable_private_connectivity = true."
  }
}

resource "aws_eip" "runtime_egress" {
  count  = var.enable_runtime_https_egress ? 1 : 0
  domain = "vpc"
  tags = {
    Name      = "wallie-staging-runtime-egress-a-eip"
    Component = "runtime-egress"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_nat_gateway" "runtime_egress" {
  count             = var.enable_runtime_https_egress ? 1 : 0
  connectivity_type = "public"
  allocation_id     = aws_eip.runtime_egress[0].id
  subnet_id         = aws_subnet.tier["public-a"].id
  depends_on        = [aws_internet_gateway.main]
  tags = {
    Name      = "wallie-staging-runtime-egress-a-nat"
    Component = "runtime-egress"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Attach this alongside application_tasks for real web/worker tasks. Keep the
# original group's two narrow egress rules unchanged for private smoke checks.
resource "aws_security_group" "runtime_egress" {
  count       = var.enable_runtime_https_egress ? 1 : 0
  name        = "wallie-staging-runtime-egress"
  description = "Outbound HTTPS for staging tasks in services-a"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.connectivity_tags, { Name = "wallie-staging-runtime-egress" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "runtime_https" {
  count             = var.enable_runtime_https_egress ? 1 : 0
  security_group_id = aws_security_group.runtime_egress[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to hosted Supabase and external integrations"
  tags              = merge(local.connectivity_tags, { Name = "wallie-staging-runtime-egress-https" })
}
