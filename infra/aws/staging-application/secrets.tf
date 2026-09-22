variable "enable_runtime_secrets" {
  description = "Create the two empty runtime secret containers only after their separate policy and plan are reviewed. Retain true after creation."
  type        = bool
  default     = false
  nullable    = false
}

# Values are populated outside Terraform in a later reviewed workflow. Do not add
# secret-version resources or value data sources to this metadata-only root.
resource "aws_secretsmanager_secret" "runtime" {
  for_each = var.enable_runtime_secrets ? toset(["web", "worker"]) : toset([])

  name                           = "/wallie/staging/${each.key}/runtime"
  description                    = "Wallie staging ${each.key} runtime secret configuration; values managed outside Terraform."
  recovery_window_in_days        = 30
  force_overwrite_replica_secret = false
  # Omit kms_key_id to use AWS-managed aws/secretsmanager in this account.
  # No initial value, replication, rotation, or resource policy is configured.

  tags = merge(local.tags, {
    Component = "runtime-secrets"
    Name      = "/wallie/staging/${each.key}/runtime"
  })

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        data.aws_caller_identity.current.account_id == var.aws_account_id &&
        !endswith(data.aws_caller_identity.current.arn, ":root")
      )
      error_message = "Use a non-root AWS identity in the expected aws_account_id."
    }
  }
}
