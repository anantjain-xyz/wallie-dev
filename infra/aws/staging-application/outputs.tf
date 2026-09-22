output "cluster" {
  description = "Empty staging ECS cluster for later application services."
  value = {
    name = aws_ecs_cluster.application.name
    arn  = aws_ecs_cluster.application.arn
  }
}

output "log_groups" {
  description = "Retained application log groups for later task execution roles, keyed by web and worker."
  value = {
    for key, group in aws_cloudwatch_log_group.application : key => {
      name              = group.name
      arn               = group.arn
      retention_in_days = group.retention_in_days
    }
  }
}
