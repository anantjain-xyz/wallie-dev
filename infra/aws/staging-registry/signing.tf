resource "aws_signer_signing_profile" "images" {
  name        = "wallie_staging_images"
  platform_id = "Notation-OCI-SHA384-ECDSA"

  signature_validity_period {
    value = 365
    type  = "DAYS"
  }

  tags = {
    Name        = "wallie_staging_images"
    Project     = "Wallie"
    Environment = "staging"
    ManagedBy   = "Terraform"
    Component   = "signing"
    WallieStack = "wallie-staging-registry"
  }

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
