output "visible_web" {
  description = "Staging-only ALB and service metadata; no certificate key or runtime secret values."
  value = var.enable_visible_web ? {
    hostname          = var.web_hostname
    certificate_arn   = aws_acm_certificate.web[0].arn
    load_balancer_arn = aws_lb.web[0].arn
    load_balancer_dns = aws_lb.web[0].dns_name
    target_group_arn  = aws_lb_target_group.web[0].arn
    service_name      = aws_ecs_service.web[0].name
    desired_count     = aws_ecs_service.web[0].desired_count
  } : null
}

output "web_certificate_validation_records" {
  description = "Copy these exact ACM DNS CNAMEs into the existing external DNS provider; Terraform never writes DNS."
  value = var.request_web_certificate ? [
    for option in aws_acm_certificate.web[0].domain_validation_options : {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  ] : []
}
