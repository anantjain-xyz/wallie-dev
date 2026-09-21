resource "aws_default_security_group" "main" {
  vpc_id  = aws_vpc.main.id
  ingress = []
  egress  = []

  tags = {
    Name      = "wallie-staging-default"
    Component = "hardening"
  }
}

resource "aws_network_acl" "sandbox" {
  vpc_id  = aws_vpc.main.id
  ingress = []
  egress  = []

  tags = {
    Name      = "wallie-staging-sandbox-quarantine"
    Component = "hardening"
    Tier      = "sandbox"
  }
}

resource "aws_network_acl_association" "sandbox" {
  for_each = { for key, subnet in local.subnets : key => subnet if subnet.tier == "sandbox" }

  subnet_id      = aws_subnet.tier[each.key].id
  network_acl_id = aws_network_acl.sandbox.id
}
