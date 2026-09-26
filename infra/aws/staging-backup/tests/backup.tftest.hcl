mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/backup-test"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      id  = "wallie-staging-postgres-backups-123456789012-us-west-2"
      arn = "arn:aws:s3:::wallie-staging-postgres-backups-123456789012-us-west-2"
    }
  }
}

variables {
  aws_account_id        = "123456789012"
  aws_region            = "us-west-2"
  backup_retention_days = 30
}

run "empty_destination_controls" {
  command = apply

  assert {
    condition = (
      aws_s3_bucket.postgres_backups.bucket == "wallie-staging-postgres-backups-123456789012-us-west-2" &&
      aws_s3_bucket.postgres_backups.object_lock_enabled &&
      !aws_s3_bucket.postgres_backups.force_destroy &&
      one(aws_s3_bucket_versioning.postgres_backups.versioning_configuration).status == "Enabled" &&
      one(one(aws_s3_bucket_server_side_encryption_configuration.postgres_backups.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256" &&
      one(aws_s3_bucket_ownership_controls.postgres_backups.rule).object_ownership == "BucketOwnerEnforced" &&
      aws_s3_bucket_public_access_block.postgres_backups.block_public_acls &&
      aws_s3_bucket_public_access_block.postgres_backups.block_public_policy &&
      aws_s3_bucket_public_access_block.postgres_backups.ignore_public_acls &&
      aws_s3_bucket_public_access_block.postgres_backups.restrict_public_buckets
    )
    error_message = "The empty backup bucket must be retained, versioned, encrypted, owner-enforced, and private."
  }

  assert {
    condition = (
      aws_s3_bucket_object_lock_configuration.postgres_backups.bucket == aws_s3_bucket.postgres_backups.id &&
      aws_s3_bucket_object_lock_configuration.postgres_backups.object_lock_enabled == "Enabled" &&
      one(one(aws_s3_bucket_object_lock_configuration.postgres_backups.rule).default_retention).mode == "GOVERNANCE" &&
      one(one(aws_s3_bucket_object_lock_configuration.postgres_backups.rule).default_retention).days == 30
    )
    error_message = "New backup versions need the explicitly reviewed governance retention rule."
  }

  assert {
    condition = (
      jsondecode(aws_s3_bucket_policy.postgres_backups.policy).Statement == [
        {
          Sid       = "DenyInsecureTransport"
          Effect    = "Deny"
          Principal = "*"
          Action    = "s3:*"
          Resource = [
            aws_s3_bucket.postgres_backups.arn,
            "${aws_s3_bucket.postgres_backups.arn}/*",
          ]
          Condition = { Bool = { "aws:SecureTransport" = "false" } }
        },
        {
          Sid       = "DenyUploadsUntilRecoveryControls"
          Effect    = "Deny"
          Principal = "*"
          Action    = ["s3:PutObject", "s3:ReplicateObject"]
          Resource  = "${aws_s3_bucket.postgres_backups.arn}/*"
        },
      ] &&
      aws_s3_bucket_policy.postgres_backups.bucket == aws_s3_bucket.postgres_backups.id
    )
    error_message = "Reject all uploads until recovery controls are designed and reject non-TLS access."
  }

  assert {
    condition = output.backup_bucket == {
      name = aws_s3_bucket.postgres_backups.id
      arn  = aws_s3_bucket.postgres_backups.arn
    }
    error_message = "Expose only the exact empty backup bucket identity."
  }
}

run "reject_wrong_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "999999999999"
      arn        = "arn:aws:iam::999999999999:user/backup-test"
    }
  }
  expect_failures = [aws_s3_bucket.postgres_backups]
}

run "reject_root_caller" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
    }
  }
  expect_failures = [aws_s3_bucket.postgres_backups]
}

run "reject_invalid_account" {
  command = plan
  variables {
    aws_account_id = "12345"
  }
  expect_failures = [var.aws_account_id]
}

run "reject_invalid_region" {
  command = plan
  variables {
    aws_region = "us_west_2"
  }
  expect_failures = [var.aws_region]
}

run "reject_zero_retention" {
  command = plan
  variables {
    backup_retention_days = 0
  }
  expect_failures = [var.backup_retention_days]
}

run "reject_fractional_retention" {
  command = plan
  variables {
    backup_retention_days = 1.5
  }
  expect_failures = [var.backup_retention_days]
}

run "reject_unbounded_retention" {
  command = plan
  variables {
    backup_retention_days = 366
  }
  expect_failures = [var.backup_retention_days]
}
