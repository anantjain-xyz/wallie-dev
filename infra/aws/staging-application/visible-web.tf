locals {
  web_tags = merge(local.tags, { Component = "visible-web" })
}

data "aws_acm_certificate" "issued_web" {
  count       = var.enable_visible_web ? 1 : 0
  domain      = var.web_hostname
  statuses    = ["ISSUED"]
  most_recent = true
}

data "aws_vpc" "web" {
  count = var.enable_visible_web ? 1 : 0
  id    = var.web_vpc_id
}

data "aws_subnet" "web_public" {
  for_each = var.enable_visible_web ? var.web_public_subnet_ids : {}
  id       = each.value
}

data "aws_subnet" "web_service" {
  count = var.enable_visible_web ? 1 : 0
  id    = var.web_service_subnet_id
}

data "aws_security_group" "web_egress" {
  count = var.enable_visible_web ? 2 : 0
  id    = var.web_egress_security_group_ids[count.index]
}

resource "aws_security_group" "web_alb" {
  count       = var.enable_visible_web ? 1 : 0
  name        = "wallie-staging-web-alb"
  description = "Staging HTTPS load balancer"
  vpc_id      = data.aws_vpc.web[0].id
  tags        = merge(local.web_tags, { Name = "wallie-staging-web-alb" })

  lifecycle {
    prevent_destroy = true
    precondition {
      condition = (
        data.aws_caller_identity.current.account_id == var.aws_account_id &&
        alltrue([for subnet in data.aws_subnet.web_public : subnet.vpc_id == var.web_vpc_id && try(subnet.tags["Tier"], "") == "public"]) &&
        length(distinct([for subnet in data.aws_subnet.web_public : subnet.availability_zone])) == 2 &&
        data.aws_subnet.web_service[0].vpc_id == var.web_vpc_id &&
        try(data.aws_subnet.web_service[0].tags["Tier"], "") == "services" &&
        alltrue([for group in data.aws_security_group.web_egress : group.vpc_id == var.web_vpc_id]) &&
        data.aws_security_group.web_egress[0].name == "wallie-staging-application-tasks" &&
        data.aws_security_group.web_egress[1].name == "wallie-staging-runtime-egress"
      )
      error_message = "Exact staging VPC, subnets, and task groups differ from the reviewed network."
    }
  }
}

resource "aws_security_group" "web_task_ingress" {
  count       = var.enable_visible_web ? 1 : 0
  name        = "wallie-staging-web-ingress"
  description = "Only the staging ALB can reach the web task"
  vpc_id      = data.aws_vpc.web[0].id
  tags        = merge(local.web_tags, { Name = "wallie-staging-web-ingress" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count             = var.enable_visible_web ? 1 : 0
  security_group_id = aws_security_group.web_alb[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Public HTTPS to staging hostname"
  tags              = merge(local.web_tags, { Name = "wallie-staging-web-alb-https" })
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  count                        = var.enable_visible_web ? 1 : 0
  security_group_id            = aws_security_group.web_alb[0].id
  referenced_security_group_id = aws_security_group.web_task_ingress[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  description                  = "ALB to web task only"
  tags                         = merge(local.web_tags, { Name = "wallie-staging-web-alb-to-task" })
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  count                        = var.enable_visible_web ? 1 : 0
  security_group_id            = aws_security_group.web_task_ingress[0].id
  referenced_security_group_id = aws_security_group.web_alb[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
  description                  = "Web task from staging ALB only"
  tags                         = merge(local.web_tags, { Name = "wallie-staging-web-task-from-alb" })
}

resource "aws_acm_certificate" "web" {
  count             = var.request_web_certificate ? 1 : 0
  domain_name       = var.web_hostname
  validation_method = "DNS"
  tags              = merge(local.web_tags, { Name = var.web_hostname })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lb" "web" {
  count                      = var.enable_visible_web ? 1 : 0
  name                       = "wallie-staging-web"
  internal                   = false
  load_balancer_type         = "application"
  subnets                    = [for slot in ["a", "b"] : data.aws_subnet.web_public[slot].id]
  security_groups            = [aws_security_group.web_alb[0].id]
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  tags                       = merge(local.web_tags, { Name = "wallie-staging-web" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lb_target_group" "web" {
  count                = var.enable_visible_web ? 1 : 0
  name                 = "wallie-staging-web"
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = data.aws_vpc.web[0].id
  deregistration_delay = 30
  tags                 = merge(local.web_tags, { Name = "wallie-staging-web" })

  health_check {
    enabled             = true
    path                = "/favicon.ico"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_lb_listener" "web_https" {
  count             = var.enable_visible_web ? 1 : 0
  load_balancer_arn = aws_lb.web[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.web_validated_certificate_arn
  tags              = merge(local.web_tags, { Name = "wallie-staging-web-https" })

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web[0].arn
  }

  lifecycle {
    prevent_destroy = true
    precondition {
      condition = (
        data.aws_acm_certificate.issued_web[0].arn == var.web_validated_certificate_arn &&
        aws_acm_certificate.web[0].arn == var.web_validated_certificate_arn
      )
      error_message = "The exact Terraform-managed staging certificate must be ISSUED before creating HTTPS ingress."
    }
  }
}

resource "aws_ecs_service" "web" {
  count                              = var.enable_visible_web ? 1 : 0
  name                               = "wallie-staging-web"
  cluster                            = aws_ecs_cluster.application.id
  task_definition                    = var.web_task_definition_arn
  desired_count                      = var.web_desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 180
  enable_execute_command             = false
  enable_ecs_managed_tags            = false
  propagate_tags                     = "NONE"
  tags                               = merge(local.web_tags, { Name = "wallie-staging-web" })
  depends_on                         = [aws_lb_listener.web_https]

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = [data.aws_subnet.web_service[0].id]
    security_groups  = concat(var.web_egress_security_group_ids, [aws_security_group.web_task_ingress[0].id])
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web[0].arn
    container_name   = "web"
    container_port   = 3000
  }

  lifecycle {
    prevent_destroy = true
  }
}
