mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/network-test"
    }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-west-2a", "us-west-2b"] }
  }
}

variables {
  aws_account_id     = "123456789012"
  aws_region         = "us-west-2"
  availability_zones = ["us-west-2a", "us-west-2b"]
}

run "default_remains_disabled" {
  command = plan
  assert {
    condition     = length(aws_vpc_endpoint.runtime_secrets) == 0 && output.runtime_secret_connectivity == null
    error_message = "Existing network inputs must add no Secrets Manager endpoint."
  }
}

run "image_connectivity_remains_four_endpoints" {
  command = plan
  variables { enable_private_connectivity = true }
  assert {
    condition = (
      length(aws_vpc_endpoint.runtime_secrets) == 0 && output.runtime_secret_connectivity == null &&
      toset(keys(aws_vpc_endpoint.application)) == toset(["ecr.api", "ecr.dkr", "logs"]) &&
      length(aws_vpc_endpoint.image_layers) == 1
    )
    error_message = "Image/log connectivity must keep its original four endpoints until separate opt-in."
  }
}

run "runtime_policy_is_separate_per_component" {
  command = plan
  variables {
    enable_private_connectivity        = true
    enable_runtime_secret_connectivity = true
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-AbC123"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  assert {
    condition = (
      length(aws_vpc_endpoint.runtime_secrets) == 1 &&
      aws_vpc_endpoint.runtime_secrets[0].service_name == "com.amazonaws.us-west-2.secretsmanager" &&
      aws_vpc_endpoint.runtime_secrets[0].vpc_endpoint_type == "Interface" &&
      aws_vpc_endpoint.runtime_secrets[0].ip_address_type == "ipv4" &&
      aws_vpc_endpoint.runtime_secrets[0].private_dns_enabled &&
      aws_vpc_endpoint.runtime_secrets[0].tags.Name == "wallie-staging-runtime-secrets" &&
      aws_vpc_endpoint.runtime_secrets[0].tags.Component == "private-connectivity"
    )
    error_message = "Create exactly one separately named private IPv4 Secrets Manager endpoint."
  }
  assert {
    condition = jsondecode(aws_vpc_endpoint.runtime_secrets[0].policy) == {
      Version = "2012-10-17"
      Statement = [
        {
          Sid       = "ReadWebRuntimeSecret"
          Effect    = "Allow"
          Principal = "*"
          Action    = "secretsmanager:GetSecretValue"
          Resource  = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-AbC123"
          Condition = {
            ArnEquals    = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/wallie-staging-web-execution" }
            StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" }
          }
        },
        {
          Sid       = "ReadWorkerRuntimeSecret"
          Effect    = "Allow"
          Principal = "*"
          Action    = "secretsmanager:GetSecretValue"
          Resource  = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
          Condition = {
            ArnEquals    = { "aws:PrincipalArn" = "arn:aws:iam::123456789012:role/wallie-staging-worker-execution" }
            StringEquals = { "aws:PrincipalAccount" = "123456789012", "aws:RequestedRegion" = "us-west-2" }
          }
        },
      ]
    }
    error_message = "Each execution role may read only its own exact secret ARN; no listing, writes, other principals, or shared resource list."
  }
}

run "runtime_connectivity_reuses_private_graph" {
  command   = apply
  state_key = "runtime_secret_connectivity"
  variables {
    enable_private_connectivity        = true
    enable_runtime_secret_connectivity = true
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-AbC123"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  assert {
    condition = (
      aws_vpc_endpoint.runtime_secrets[0].vpc_id == aws_vpc.main.id &&
      aws_vpc_endpoint.runtime_secrets[0].subnet_ids == toset([aws_subnet.tier["services-a"].id, aws_subnet.tier["services-b"].id]) &&
      aws_vpc_endpoint.runtime_secrets[0].security_group_ids == toset([aws_security_group.aws_endpoints[0].id]) &&
      length(aws_security_group.application_tasks) == 1 && length(aws_security_group.aws_endpoints) == 1 &&
      length(aws_vpc_security_group_ingress_rule.endpoint_https) == 1 &&
      length(aws_vpc_security_group_egress_rule.task_endpoints_https) == 1 &&
      length(aws_vpc_security_group_egress_rule.task_s3_https) == 1 &&
      output.runtime_secret_connectivity.id == aws_vpc_endpoint.runtime_secrets[0].id &&
      output.runtime_secret_connectivity.runtime_secret_arns == var.runtime_secret_arns &&
      toset(keys(output.application_connectivity.interface_endpoints)) == toset(["ecr.api", "ecr.dkr", "logs"])
    )
    error_message = "Reuse only the two existing service subnets and endpoint SG/rules; keep image/log output unchanged and expose secret endpoint metadata separately."
  }
}

run "reject_missing_private_connectivity" {
  command = plan
  variables {
    enable_runtime_secret_connectivity = true
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-AbC123"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  expect_failures = [var.enable_runtime_secret_connectivity]
}

run "reject_missing_arns" {
  command = plan
  variables {
    enable_private_connectivity        = true
    enable_runtime_secret_connectivity = true
  }
  expect_failures = [var.runtime_secret_arns]
}

run "reject_missing_component" {
  command = plan
  variables {
    runtime_secret_arns = { web = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-AbC123" }
  }
  expect_failures = [var.runtime_secret_arns]
}

run "reject_cross_account" {
  command = plan
  variables {
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-west-2:999999999999:secret:/wallie/staging/web/runtime-AbC123"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  expect_failures = [var.runtime_secret_arns]
}

run "reject_cross_region" {
  command = plan
  variables {
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:/wallie/staging/web/runtime-AbC123"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  expect_failures = [var.runtime_secret_arns]
}

run "reject_cross_component" {
  command = plan
  variables {
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-AbC123"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  expect_failures = [var.runtime_secret_arns]
}

run "reject_wildcard_suffix" {
  command = plan
  variables {
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-??????"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  expect_failures = [var.runtime_secret_arns]
}

run "reject_partial_arn" {
  command = plan
  variables {
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  expect_failures = [var.runtime_secret_arns]
}

run "reject_extra_component" {
  command = plan
  variables {
    runtime_secret_arns = {
      web    = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/web/runtime-AbC123"
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
      other  = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/other/runtime-gHi789"
    }
  }
  expect_failures = [var.runtime_secret_arns]
}

run "reject_null_arn" {
  command = plan
  variables {
    runtime_secret_arns = {
      web    = null
      worker = "arn:aws:secretsmanager:us-west-2:123456789012:secret:/wallie/staging/worker/runtime-dEf456"
    }
  }
  expect_failures = [var.runtime_secret_arns]
}
