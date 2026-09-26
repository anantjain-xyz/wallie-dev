mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/visible-web-test"
    }
  }
  mock_data "aws_iam_role" {
    defaults = {
      arn  = "arn:aws:iam::123456789012:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS"
      path = "/aws-service-role/ecs.amazonaws.com/"
    }
  }
  mock_data "aws_acm_certificate" {
    defaults = {
      arn    = "arn:aws:acm:us-west-2:123456789012:certificate/12345678-1234-1234-1234-123456789012"
      status = "ISSUED"
    }
  }
}

variables {
  aws_account_id = "123456789012"
  aws_region     = "us-west-2"
}

run "existing_root_stays_dark" {
  command = plan

  assert {
    condition = (
      length(aws_lb.web) == 0 &&
      length(aws_acm_certificate.web) == 0 &&
      length(aws_ecs_service.web) == 0 &&
      length(data.aws_acm_certificate.issued_web) == 0
    )
    error_message = "Default application plans must contain no visible web resources."
  }
}

run "reject_production_hostname" {
  command = plan
  variables {
    web_hostname = "wallie.dev"
  }
  expect_failures = [var.web_hostname]
}

run "certificate_request_only" {
  command = plan
  variables {
    request_web_certificate = true
  }
  assert {
    condition = (
      length(aws_acm_certificate.web) == 1 &&
      length(aws_lb.web) == 0 &&
      length(aws_ecs_service.web) == 0
    )
    error_message = "First phase must request only the ACM certificate."
  }
}

run "reviewed_web_topology" {
  command = plan
  variables {
    enable_visible_web            = true
    request_web_certificate       = true
    web_validated_certificate_arn = "arn:aws:acm:us-west-2:123456789012:certificate/12345678-1234-1234-1234-123456789012"
    web_vpc_id                    = "vpc-12345678"
    web_public_subnet_ids         = { a = "subnet-12345678", b = "subnet-abcdef12" }
    web_service_subnet_id         = "subnet-87654321"
    web_egress_security_group_ids = ["sg-12345678", "sg-abcdef12"]
    web_task_definition_arn       = "arn:aws:ecs:us-west-2:123456789012:task-definition/wallie-staging-web-app:7"
  }

  override_data {
    target = data.aws_subnet.web_public["a"]
    values = {
      vpc_id            = "vpc-12345678"
      availability_zone = "us-west-2a"
      tags              = { Tier = "public" }
    }
  }
  override_data {
    target = data.aws_subnet.web_public["b"]
    values = {
      vpc_id            = "vpc-12345678"
      availability_zone = "us-west-2b"
      tags              = { Tier = "public" }
    }
  }
  override_data {
    target = data.aws_subnet.web_service[0]
    values = {
      vpc_id = "vpc-12345678"
      tags   = { Tier = "services" }
    }
  }
  override_data {
    target = data.aws_security_group.web_egress[0]
    values = {
      vpc_id = "vpc-12345678"
      name   = "wallie-staging-application-tasks"
    }
  }
  override_data {
    target = data.aws_security_group.web_egress[1]
    values = {
      vpc_id = "vpc-12345678"
      name   = "wallie-staging-runtime-egress"
    }
  }

  assert {
    condition = (
      aws_lb.web[0].internal == false &&
      aws_lb.web[0].load_balancer_type == "application" &&
      aws_lb.web[0].enable_deletion_protection &&
      aws_acm_certificate.web[0].domain_name == "aws-staging.wallie.dev" &&
      aws_lb_listener.web_https[0].port == 443 &&
      aws_lb_listener.web_https[0].protocol == "HTTPS" &&
      aws_lb_target_group.web[0].target_type == "ip" &&
      aws_lb_target_group.web[0].port == 3000
    )
    error_message = "Only the staging HTTPS ALB and IP target group may be created."
  }

  assert {
    condition = (
      aws_ecs_service.web[0].name == "wallie-staging-web" &&
      aws_ecs_service.web[0].desired_count == 0 &&
      aws_ecs_service.web[0].task_definition == var.web_task_definition_arn &&
      aws_ecs_service.web[0].launch_type == "FARGATE" &&
      aws_ecs_service.web[0].platform_version == "1.4.0" &&
      one(aws_ecs_service.web[0].network_configuration).assign_public_ip == false &&
      one(aws_ecs_service.web[0].deployment_circuit_breaker).enable &&
      one(aws_ecs_service.web[0].deployment_circuit_breaker).rollback
    )
    error_message = "Service phase must create a private zero-task web service with rollback enabled."
  }
}
