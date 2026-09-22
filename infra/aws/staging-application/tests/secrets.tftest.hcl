mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/secrets-test"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::123456789012:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS"
      path = "/aws-service-role/ecs.amazonaws.com/"
    }
  }
}

variables {
  aws_account_id = "123456789012"
  aws_region     = "us-west-2"
}

run "default_foundation_has_no_secrets" {
  command = plan
  assert {
    condition     = length(aws_secretsmanager_secret.runtime) == 0 && length(output.runtime_secrets) == 0
    error_message = "Existing application plans must not add secrets without explicit opt-in."
  }
}

run "enabled_containers" {
  command = plan
  variables {
    enable_runtime_secrets = true
  }
  assert {
    condition = {
      for component, secret in aws_secretsmanager_secret.runtime : component => secret.name
      } == {
      web    = "/wallie/staging/web/runtime"
      worker = "/wallie/staging/worker/runtime"
    }
    error_message = "Opt-in must create exactly the two fixed component containers."
  }
  assert {
    condition = alltrue([
      for secret in aws_secretsmanager_secret.runtime :
      secret.kms_key_id == null && secret.recovery_window_in_days == 30 &&
      length(secret.replica) == 0 && !secret.force_overwrite_replica_secret
    ])
    error_message = "Use default AWS-managed encryption, 30-day recovery, and no replicas."
  }
  assert {
    condition = alltrue([
      for component, secret in aws_secretsmanager_secret.runtime : secret.tags == tomap({
        Name        = "/wallie/staging/${component}/runtime"
        Project     = "Wallie"
        Environment = "staging"
        ManagedBy   = "Terraform"
        Component   = "runtime-secrets"
        WallieStack = "wallie-staging-application"
      })
    ])
    error_message = "Each container must retain its exact name and application ownership tags."
  }
  assert {
    condition = (
      aws_ecs_cluster.application.name == "wallie-staging" &&
      length(aws_cloudwatch_log_group.application) == 2 &&
      alltrue([for group in aws_cloudwatch_log_group.application : group.retention_in_days == 30 && group.deletion_protection_enabled])
    )
    error_message = "Enabling secrets must preserve the existing cluster/log-group settings."
  }
}

run "metadata_outputs" {
  command = apply
  variables {
    enable_runtime_secrets = true
  }
  override_resource {
    target = aws_secretsmanager_secret.runtime["web"]
    values = {
      arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-a1b2c3"
    }
  }
  override_resource {
    target = aws_secretsmanager_secret.runtime["worker"]
    values = {
      arn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-d4e5f6"
    }
  }
  assert {
    condition = output.runtime_secrets == {
      web = {
        name = "/wallie/staging/web/runtime"
        arn  = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-a1b2c3"
      }
      worker = {
        name = "/wallie/staging/worker/runtime"
        arn  = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-d4e5f6"
      }
    }
    error_message = "Outputs must expose only names and complete ARNs, never values or versions."
  }
}

run "reject_wrong_account" {
  command = plan
  variables {
    enable_runtime_secrets = true
  }
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "999999999999"
      arn        = "arn:aws:iam::999999999999:user/secrets-test"
    }
  }
  expect_failures = [aws_ecs_cluster.application, aws_cloudwatch_log_group.application, aws_secretsmanager_secret.runtime]
}

run "reject_root" {
  command = plan
  variables {
    enable_runtime_secrets = true
  }
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
    }
  }
  expect_failures = [aws_ecs_cluster.application, aws_cloudwatch_log_group.application, aws_secretsmanager_secret.runtime]
}
