mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/application-test"
    }
  }

  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::123456789012:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS"
      path = "/aws-service-role/ecs.amazonaws.com/"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-west-2:123456789012:cluster/wallie-staging"
    }
  }
}

variables {
  aws_account_id = "123456789012"
  aws_region     = "us-west-2"
}

run "cluster_configuration" {
  command = plan

  assert {
    condition = (
      aws_ecs_cluster.application.name == "wallie-staging" &&
      one(aws_ecs_cluster.application.setting).name == "containerInsights" &&
      one(aws_ecs_cluster.application.setting).value == "disabled"
    )
    error_message = "Use the fixed staging cluster and explicitly disable inherited Container Insights."
  }

  assert {
    condition = (
      length(aws_ecs_cluster.application.configuration) == 0 &&
      length(aws_ecs_cluster.application.service_connect_defaults) == 0
    )
    error_message = "The empty cluster must not configure Exec, managed storage, or Service Connect."
  }

  assert {
    condition = aws_ecs_cluster.application.tags == tomap({
      Name        = "wallie-staging"
      Project     = "Wallie"
      Environment = "staging"
      ManagedBy   = "Terraform"
      Component   = "application"
      WallieStack = "wallie-staging-application"
    })
    error_message = "The cluster must carry the application ownership marker and reviewed metadata."
  }
}

run "log_configuration" {
  command = plan

  assert {
    condition = {
      for key, group in aws_cloudwatch_log_group.application : key => group.name
      } == {
      web    = "/wallie/staging/web"
      worker = "/wallie/staging/worker"
    }
    error_message = "Create only the fixed web and worker log groups."
  }

  assert {
    condition = alltrue([
      for group in aws_cloudwatch_log_group.application :
      group.retention_in_days == 30 &&
      group.log_group_class == "STANDARD" &&
      group.deletion_protection_enabled &&
      group.kms_key_id == null
    ])
    error_message = "Logs must use 30-day retention, STANDARD class, native deletion protection, and default AWS encryption."
  }

  assert {
    condition = alltrue([
      for key, group in aws_cloudwatch_log_group.application : group.tags == tomap({
        Name        = "/wallie/staging/${key}"
        Project     = "Wallie"
        Environment = "staging"
        ManagedBy   = "Terraform"
        Component   = "application"
        WallieStack = "wallie-staging-application"
      })
    ])
    error_message = "Log groups must carry the application ownership marker and reviewed metadata."
  }
}

# Mock-generated attributes verify output wiring without creating AWS resources.
run "application_outputs" {
  command = apply

  assert {
    condition = output.cluster == {
      name = "wallie-staging"
      arn  = "arn:aws:ecs:us-west-2:123456789012:cluster/wallie-staging"
    }
    error_message = "Expose the exact cluster name and ARN for later services."
  }

  assert {
    condition = (
      toset(keys(output.log_groups)) == toset(["web", "worker"]) &&
      alltrue([
        for key, group in output.log_groups :
        group.name == aws_cloudwatch_log_group.application[key].name &&
        group.arn == aws_cloudwatch_log_group.application[key].arn &&
        length(group.arn) > 0 && group.retention_in_days == 30
      ])
    )
    error_message = "Expose only the matching web/worker log names, ARNs, and retention periods."
  }
}

run "reject_invalid_account" {
  command = plan
  variables {
    aws_account_id = "12345"
  }
  expect_failures = [var.aws_account_id]
}

run "reject_invalid_region" {
  command = plan
  variables {
    aws_region = "us_west_2"
  }
  expect_failures = [var.aws_region]
}

run "reject_china_region" {
  command = plan
  variables {
    aws_region = "cn-north-1"
  }
  expect_failures = [var.aws_region]
}

run "reject_govcloud_region" {
  command = plan
  variables {
    aws_region = "us-gov-west-1"
  }
  expect_failures = [var.aws_region]
}

run "reject_wrong_caller_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "999999999999"
      arn        = "arn:aws:iam::999999999999:user/application-test"
    }
  }
  expect_failures = [aws_ecs_cluster.application, aws_cloudwatch_log_group.application]
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
  expect_failures = [aws_ecs_cluster.application, aws_cloudwatch_log_group.application]
}

run "reject_wrong_service_role_arn" {
  command = plan
  override_data {
    target = data.aws_iam_role.ecs_service
    values = {
      arn  = "arn:aws:iam::999999999999:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS"
      path = "/aws-service-role/ecs.amazonaws.com/"
    }
  }
  expect_failures = [aws_ecs_cluster.application, aws_cloudwatch_log_group.application]
}

run "reject_wrong_service_role_path" {
  command = plan
  override_data {
    target = data.aws_iam_role.ecs_service
    values = {
      arn  = "arn:aws:iam::123456789012:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS"
      path = "/"
    }
  }
  expect_failures = [aws_ecs_cluster.application, aws_cloudwatch_log_group.application]
}
