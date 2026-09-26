mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/postgres-test"
    }
  }

  mock_data "aws_ami" {
    defaults = {
      id               = "ami-0123456789abcdef0"
      name             = "al2023-ami-2023.10.20260901.0-kernel-6.1-x86_64"
      architecture     = "x86_64"
      root_device_type = "ebs"
    }
  }

  mock_data "aws_subnet" {
    defaults = {
      id                      = "subnet-0123456789abcdef0"
      vpc_id                  = "vpc-0123456789abcdef0"
      availability_zone       = "us-west-2a"
      map_public_ip_on_launch = false
      tags = {
        Name = "wallie-staging-database-a"
        Tier = "database"
      }
    }
  }

  mock_data "aws_security_group" {
    defaults = {
      id     = "sg-0123456789abcdef0"
      name   = "wallie-staging-supabase-db"
      vpc_id = "vpc-0123456789abcdef0"
    }
  }
}

variables {
  aws_account_id             = "123456789012"
  aws_region                 = "us-west-2"
  vpc_id                     = "vpc-0123456789abcdef0"
  database_subnet_id         = "subnet-0123456789abcdef0"
  database_security_group_id = "sg-0123456789abcdef0"
  ami_id                     = "ami-0123456789abcdef0"
  ebs_kms_key_arn            = "arn:aws:kms:us-west-2:123456789012:key/01234567-89ab-cdef-0123-456789abcdef"
}

run "private_host_and_persistent_data" {
  command = apply

  assert {
    condition = (
      aws_instance.host.ami == data.aws_ami.pinned.id &&
      aws_instance.host.subnet_id == data.aws_subnet.database.id &&
      toset(aws_instance.host.vpc_security_group_ids) == toset([data.aws_security_group.database.id]) &&
      aws_instance.host.associate_public_ip_address == false &&
      aws_instance.host.user_data == null &&
      aws_instance.host.disable_api_termination &&
      aws_instance.host.ebs_optimized
    )
    error_message = "The host must use the exact reviewed AMI, database subnet, and SG without a public IP or bootstrap script."
  }

  assert {
    condition = (
      one(aws_instance.host.metadata_options).http_endpoint == "enabled" &&
      one(aws_instance.host.metadata_options).http_tokens == "required" &&
      one(aws_instance.host.metadata_options).http_put_response_hop_limit == 1 &&
      one(aws_instance.host.root_block_device).encrypted &&
      one(aws_instance.host.root_block_device).kms_key_id == var.ebs_kms_key_arn &&
      one(aws_instance.host.root_block_device).delete_on_termination
    )
    error_message = "Require IMDSv2 and a separately disposable encrypted OS volume."
  }

  assert {
    condition = (
      aws_ebs_volume.data.availability_zone == data.aws_subnet.database.availability_zone &&
      aws_ebs_volume.data.encrypted &&
      aws_ebs_volume.data.kms_key_id == var.ebs_kms_key_arn &&
      aws_ebs_volume.data.type == "gp3" &&
      !aws_ebs_volume.data.multi_attach_enabled &&
      aws_volume_attachment.data.volume_id == aws_ebs_volume.data.id &&
      aws_volume_attachment.data.instance_id == aws_instance.host.id
    )
    error_message = "Data must be a separately attached encrypted single-host EBS volume in the same AZ."
  }
}

run "ssm_only_admin_path" {
  command = apply

  assert {
    condition = (
      aws_iam_role.host.permissions_boundary == "arn:aws:iam::123456789012:policy/WallieStagingPostgresHostBoundary" &&
      toset(keys(aws_vpc_endpoint.ssm)) == toset(["ssm", "ssmmessages"]) &&
      alltrue([for endpoint in aws_vpc_endpoint.ssm :
        endpoint.vpc_id == var.vpc_id &&
        endpoint.vpc_endpoint_type == "Interface" &&
        endpoint.private_dns_enabled &&
        toset(endpoint.subnet_ids) == toset([data.aws_subnet.database.id]) &&
        toset(endpoint.security_group_ids) == toset([aws_security_group.ssm_endpoints.id])
      ]) &&
      length(aws_security_group.ssm_endpoints.ingress) == 0 &&
      length(aws_security_group.ssm_endpoints.egress) == 0
    )
    error_message = "Only two private SSM endpoints are permitted, with no default SG rules."
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.database_ssm.security_group_id == data.aws_security_group.database.id &&
      aws_vpc_security_group_egress_rule.database_ssm.referenced_security_group_id == aws_security_group.ssm_endpoints.id &&
      aws_vpc_security_group_egress_rule.database_ssm.ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.database_ssm.from_port == 443 &&
      aws_vpc_security_group_egress_rule.database_ssm.to_port == 443 &&
      aws_vpc_security_group_egress_rule.database_ssm.cidr_ipv4 == null &&
      aws_vpc_security_group_egress_rule.database_ssm.cidr_ipv6 == null &&
      aws_vpc_security_group_ingress_rule.ssm_database.security_group_id == aws_security_group.ssm_endpoints.id &&
      aws_vpc_security_group_ingress_rule.ssm_database.referenced_security_group_id == data.aws_security_group.database.id &&
      aws_vpc_security_group_ingress_rule.ssm_database.ip_protocol == "tcp" &&
      aws_vpc_security_group_ingress_rule.ssm_database.from_port == 443 &&
      aws_vpc_security_group_ingress_rule.ssm_database.to_port == 443 &&
      aws_vpc_security_group_ingress_rule.ssm_database.cidr_ipv4 == null &&
      aws_vpc_security_group_ingress_rule.ssm_database.cidr_ipv6 == null &&
      toset(jsondecode(aws_iam_role_policy.ssm.policy).Statement[0].Action) == toset([
        "ssm:UpdateInstanceInformation",
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]) &&
      jsondecode(aws_iam_role_policy.ssm.policy).Statement[0].Resource == "*"
    )
    error_message = "SSM must use only SG-referenced HTTPS and the five minimal instance-role actions."
  }
}

run "reject_public_subnet" {
  command = plan
  override_data {
    target = data.aws_subnet.database
    values = {
      map_public_ip_on_launch = true
    }
  }
  expect_failures = [aws_instance.host]
}

run "reject_wrong_caller_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "999999999999"
      arn        = "arn:aws:iam::999999999999:user/postgres-test"
    }
  }
  expect_failures = [aws_instance.host]
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
  expect_failures = [aws_instance.host]
}

run "reject_wrong_ami" {
  command = plan
  override_data {
    target = data.aws_ami.pinned
    values = {
      name = "amzn2-ami-hvm-2.0.20240101.0-x86_64-gp2"
    }
  }
  expect_failures = [aws_instance.host]
}

run "reject_wrong_security_group" {
  command = plan
  override_data {
    target = data.aws_security_group.database
    values = {
      name = "default"
    }
  }
  expect_failures = [aws_instance.host]
}

run "reject_invalid_volume_size" {
  command = plan
  variables {
    data_volume_gib = 10
  }
  expect_failures = [var.data_volume_gib]
}

run "reject_wrong_kms_key_account" {
  command = plan
  variables {
    ebs_kms_key_arn = "arn:aws:kms:us-west-2:999999999999:key/01234567-89ab-cdef-0123-456789abcdef"
  }
  expect_failures = [var.ebs_kms_key_arn]
}
