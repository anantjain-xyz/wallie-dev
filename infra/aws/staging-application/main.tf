locals {
  tags = {
    Project     = "Wallie"
    Environment = "staging"
    ManagedBy   = "Terraform"
    Component   = "application"
    WallieStack = "wallie-staging-application"
  }
  expected_service_role_arn  = "arn:aws:iam::${var.aws_account_id}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS"
  expected_service_role_path = "/aws-service-role/ecs.amazonaws.com/"
}

data "aws_caller_identity" "current" {}

# Creating a cluster may otherwise create this account-wide role implicitly.
# Require it to exist already; this root never creates or manages IAM roles.
data "aws_iam_role" "ecs_service" {
  name = "AWSServiceRoleForECS"
}

resource "aws_ecs_cluster" "application" {
  name = "wallie-staging"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = merge(local.tags, { Name = "wallie-staging" })

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        data.aws_caller_identity.current.account_id == var.aws_account_id &&
        !endswith(data.aws_caller_identity.current.arn, ":root")
      )
      error_message = "Use a non-root AWS identity in the expected aws_account_id."
    }

    precondition {
      condition = (
        data.aws_iam_role.ecs_service.arn == local.expected_service_role_arn &&
        data.aws_iam_role.ecs_service.path == local.expected_service_role_path
      )
      error_message = "The expected account must already have the AWS-managed ECS service-linked role."
    }
  }
}

resource "aws_cloudwatch_log_group" "application" {
  for_each = toset(["web", "worker"])

  name                        = "/wallie/staging/${each.key}"
  log_group_class             = "STANDARD"
  retention_in_days           = 30
  deletion_protection_enabled = true
  # CloudWatch encrypts logs at rest by default; a customer KMS key is deferred.

  tags = merge(local.tags, { Name = "/wallie/staging/${each.key}" })

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        data.aws_caller_identity.current.account_id == var.aws_account_id &&
        !endswith(data.aws_caller_identity.current.arn, ":root")
      )
      error_message = "Use a non-root AWS identity in the expected aws_account_id."
    }

    precondition {
      condition = (
        data.aws_iam_role.ecs_service.arn == local.expected_service_role_arn &&
        data.aws_iam_role.ecs_service.path == local.expected_service_role_path
      )
      error_message = "The expected account must already have the AWS-managed ECS service-linked role."
    }
  }
}
