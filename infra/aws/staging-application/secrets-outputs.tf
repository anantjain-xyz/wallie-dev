output "runtime_secrets" {
  description = "Runtime secret metadata only, keyed by component; empty until enable_runtime_secrets is true."
  value = {
    for component, secret in aws_secretsmanager_secret.runtime : component => {
      name = secret.name
      arn  = secret.arn
    }
  }
}
