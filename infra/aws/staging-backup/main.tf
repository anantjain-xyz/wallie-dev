data "aws_caller_identity" "current" {}

locals {
  bucket_name = "wallie-staging-postgres-backups-${var.aws_account_id}-${var.aws_region}"
}

# This root owns an empty destination only. The bucket policy blocks all uploads
# until retention, a narrow writer, private S3 access, and recovery are reviewed.
resource "aws_s3_bucket" "postgres_backups" {
  bucket              = local.bucket_name
  object_lock_enabled = true
  force_destroy       = false

  tags = {
    Name        = local.bucket_name
    Project     = "Wallie"
    Environment = "staging"
    ManagedBy   = "Terraform"
    Component   = "postgres-backup"
    WallieStack = "wallie-staging-backup"
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

resource "aws_s3_bucket_versioning" "postgres_backups" {
  bucket = aws_s3_bucket.postgres_backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

# A reviewed duration is required for every apply. The separate upload deny
# remains in force until the backup writer and restore path are qualified.
resource "aws_s3_bucket_object_lock_configuration" "postgres_backups" {
  bucket              = aws_s3_bucket.postgres_backups.id
  object_lock_enabled = "Enabled"

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.backup_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.postgres_backups]

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "postgres_backups" {
  bucket = aws_s3_bucket.postgres_backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_ownership_controls" "postgres_backups" {
  bucket = aws_s3_bucket.postgres_backups.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "postgres_backups" {
  bucket = aws_s3_bucket.postgres_backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "postgres_backups" {
  bucket = aws_s3_bucket.postgres_backups.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.postgres_backups.arn,
          "${aws_s3_bucket.postgres_backups.arn}/*",
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        Sid       = "DenyUploadsUntilRecoveryControls"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:PutObject", "s3:ReplicateObject"]
        Resource  = "${aws_s3_bucket.postgres_backups.arn}/*"
      },
    ]
  })

  depends_on = [aws_s3_bucket_public_access_block.postgres_backups]
}
