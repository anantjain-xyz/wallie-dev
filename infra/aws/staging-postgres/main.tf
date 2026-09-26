data "aws_caller_identity" "current" {}

data "aws_ami" "pinned" {
  owners = ["amazon"]

  filter {
    name   = "image-id"
    values = [var.ami_id]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }
}

data "aws_subnet" "database" {
  id = var.database_subnet_id
}

data "aws_security_group" "database" {
  id = var.database_security_group_id
}

locals {
  name = "wallie-staging-postgres"
}

# This profile supports private SSM registration and pull of the pinned
# PostgreSQL image. Database secrets and backups need separate review.
resource "aws_iam_role" "host" {
  name                 = local.name
  permissions_boundary = "arn:aws:iam::${var.aws_account_id}:policy/WallieStagingPostgresHostBoundary"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
  tags = { Name = local.name }

  lifecycle {
    prevent_destroy = true
  }
}

# AWS's managed core policy also grants account-wide Parameter Store reads.
# Use AWS's documented minimal Session Manager actions instead.
resource "aws_iam_role_policy" "ssm" {
  name = "${local.name}-session"
  role = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:UpdateInstanceInformation",
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      Resource = "*"
    }]
  })

  lifecycle {
    prevent_destroy = true
  }
}

# The host can authenticate to ECR and pull only the dedicated PostgreSQL
# repository. The repository tag check fails closed if ownership drifts.
resource "aws_iam_role_policy" "postgres_image_pull" {
  name = "${local.name}-image-pull"
  role = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AuthenticateEcr"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:PrincipalAccount" = var.aws_account_id
            "aws:RequestedRegion"  = var.aws_region
          }
        }
      },
      {
        Sid    = "PullPostgresImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = "arn:aws:ecr:${var.aws_region}:${var.aws_account_id}:repository/wallie-staging/supabase-postgres"
        Condition = {
          StringEquals = {
            "aws:PrincipalAccount"        = var.aws_account_id
            "aws:RequestedRegion"         = var.aws_region
            "aws:ResourceTag/WallieStack" = "wallie-staging-registry"
          }
        }
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_instance_profile" "host" {
  name = local.name
  role = aws_iam_role.host.name
  tags = { Name = local.name }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_security_group" "ssm_endpoints" {
  name        = "${local.name}-ssm-endpoints"
  description = "Private SSM endpoints for the staging PostgreSQL host"
  vpc_id      = var.vpc_id
  tags        = { Name = "${local.name}-ssm-endpoints" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_egress_rule" "database_ssm" {
  security_group_id            = data.aws_security_group.database.id
  referenced_security_group_id = aws_security_group.ssm_endpoints.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "SSM agent to private SSM endpoints"
  tags                         = { Name = "${local.name}-ssm-egress" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "ssm_database" {
  security_group_id            = aws_security_group.ssm_endpoints.id
  referenced_security_group_id = data.aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  description                  = "SSM agent from the staging PostgreSQL host"
  tags                         = { Name = "${local.name}-ssm-ingress" }

  lifecycle {
    prevent_destroy = true
  }
}

# Current AL2023 SSM Agent uses ssmmessages for its data and control channels.
# Pin and verify the AMI's agent version before deploying; older agents may
# require ec2messages, which this intentionally narrow path does not provide.
resource "aws_vpc_endpoint" "ssm" {
  for_each = toset(["ssm", "ssmmessages"])

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  ip_address_type     = "ipv4"
  private_dns_enabled = true
  subnet_ids          = [data.aws_subnet.database.id]
  security_group_ids  = [aws_security_group.ssm_endpoints.id]
  tags                = { Name = "${local.name}-${each.key}" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "host" {
  ami                         = data.aws_ami.pinned.id
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnet.database.id
  vpc_security_group_ids      = [data.aws_security_group.database.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  associate_public_ip_address = false
  ebs_optimized               = true
  disable_api_termination     = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 20
    encrypted             = true
    kms_key_id            = var.ebs_kms_key_arn
    delete_on_termination = true
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  tags = { Name = local.name }

  depends_on = [
    aws_iam_role_policy.ssm,
    aws_iam_role_policy.postgres_image_pull,
    aws_vpc_security_group_egress_rule.database_ssm,
    aws_vpc_security_group_ingress_rule.ssm_database,
    aws_vpc_endpoint.ssm,
  ]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        data.aws_caller_identity.current.account_id == var.aws_account_id &&
        !endswith(data.aws_caller_identity.current.arn, ":root")
      )
      error_message = "Use a non-root identity in the expected AWS account."
    }

    precondition {
      condition = (
        startswith(data.aws_ami.pinned.name, "al2023-ami-2023.") &&
        data.aws_ami.pinned.architecture == "x86_64" &&
        data.aws_ami.pinned.root_device_type == "ebs"
      )
      error_message = "The pinned Amazon-owned AMI must be an AL2023 x86-64 EBS image."
    }

    precondition {
      condition = (
        data.aws_subnet.database.vpc_id == var.vpc_id &&
        !data.aws_subnet.database.map_public_ip_on_launch &&
        lookup(data.aws_subnet.database.tags, "Name", "") == "wallie-staging-database-a" &&
        lookup(data.aws_subnet.database.tags, "Tier", "") == "database"
      )
      error_message = "Use the private wallie-staging-database-a subnet in the expected VPC."
    }

    precondition {
      condition = (
        data.aws_security_group.database.vpc_id == var.vpc_id &&
        data.aws_security_group.database.name == "wallie-staging-supabase-db"
      )
      error_message = "Use the reviewed self-hosted Supabase database security group."
    }
  }
}

# Separate from the instance lifecycle. Both PGDATA and the future Supabase
# pgsodium key must live on this volume before any real database starts.
resource "aws_ebs_volume" "data" {
  availability_zone    = data.aws_subnet.database.availability_zone
  size                 = var.data_volume_gib
  type                 = "gp3"
  iops                 = 3000
  throughput           = 125
  encrypted            = true
  kms_key_id           = var.ebs_kms_key_arn
  multi_attach_enabled = false
  tags                 = { Name = "${local.name}-data" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  instance_id                    = aws_instance.host.id
  volume_id                      = aws_ebs_volume.data.id
  stop_instance_before_detaching = true

  lifecycle {
    prevent_destroy = true
  }
}
