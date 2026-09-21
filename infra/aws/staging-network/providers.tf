provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project     = "Wallie"
      Environment = "staging"
      ManagedBy   = "Terraform"
      Component   = "network"
      WallieStack = "wallie-staging-network"
    }
  }
}
