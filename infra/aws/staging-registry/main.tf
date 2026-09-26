data "aws_caller_identity" "current" {}

resource "aws_ecr_repository" "application" {
  for_each = toset(["web", "worker"])

  name                 = "wallie-staging/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name        = "wallie-staging/${each.key}"
    Project     = "Wallie"
    Environment = "staging"
    ManagedBy   = "Terraform"
    Component   = "registry"
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

# Keep the upstream database image separate from Wallie's web/worker build
# repositories. A later workflow will mirror the locked Supabase image here.
resource "aws_ecr_repository" "supabase_postgres" {
  name                 = "wallie-staging/supabase-postgres"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name        = "wallie-staging/supabase-postgres"
    Project     = "Wallie"
    Environment = "staging"
    ManagedBy   = "Terraform"
    Component   = "registry"
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
