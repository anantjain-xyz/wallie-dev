mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:user/registry-test"
    }
  }

  mock_resource "aws_signer_signing_profile" {
    defaults = {
      arn         = "arn:aws:signer:us-west-2:123456789012:/signing-profiles/wallie_staging_images"
      version     = "a1b2c3d4e5"
      version_arn = "arn:aws:signer:us-west-2:123456789012:/signing-profiles/wallie_staging_images/a1b2c3d4e5"
      status      = "Active"
    }
  }
}

variables {
  aws_account_id = "123456789012"
  aws_region     = "us-west-2"
}

run "repository_configuration" {
  command = plan

  assert {
    condition = {
      for key, repository in aws_ecr_repository.application : key => repository.name
      } == {
      web    = "wallie-staging/web"
      worker = "wallie-staging/worker"
    }
    error_message = "Create only the fixed web and worker repositories."
  }

  assert {
    condition = (
      aws_ecr_repository.supabase_postgres.name == "wallie-staging/supabase-postgres" &&
      aws_ecr_repository.supabase_postgres.image_tag_mutability == "IMMUTABLE" &&
      length(aws_ecr_repository.supabase_postgres.image_tag_mutability_exclusion_filter) == 0 &&
      !aws_ecr_repository.supabase_postgres.force_delete &&
      one(aws_ecr_repository.supabase_postgres.encryption_configuration).encryption_type == "AES256" &&
      one(aws_ecr_repository.supabase_postgres.image_scanning_configuration).scan_on_push
    )
    error_message = "Reserve one immutable, encrypted, scanned Supabase PostgreSQL repository."
  }

  assert {
    condition = alltrue([
      for repository in aws_ecr_repository.application :
      repository.image_tag_mutability == "IMMUTABLE" &&
      length(repository.image_tag_mutability_exclusion_filter) == 0 &&
      !repository.force_delete
    ])
    error_message = "Release tags must be immutable and nonempty repositories must not be force-deleted."
  }

  assert {
    condition = alltrue([
      for repository in aws_ecr_repository.application :
      one(repository.encryption_configuration).encryption_type == "AES256" &&
      one(repository.image_scanning_configuration).scan_on_push
    ])
    error_message = "Each repository must explicitly enable AES-256 encryption and scan-on-push."
  }

  assert {
    condition = alltrue([
      for key, repository in aws_ecr_repository.application : repository.tags == tomap({
        Name        = "wallie-staging/${key}"
        Project     = "Wallie"
        Environment = "staging"
        ManagedBy   = "Terraform"
        Component   = "registry"
        WallieStack = "wallie-staging-registry"
      })
    ])
    error_message = "Repositories must carry the registry ownership marker and reviewed metadata."
  }

  assert {
    condition = aws_ecr_repository.supabase_postgres.tags == tomap({
      Name        = "wallie-staging/supabase-postgres"
      Project     = "Wallie"
      Environment = "staging"
      ManagedBy   = "Terraform"
      Component   = "registry"
      WallieStack = "wallie-staging-registry"
    })
    error_message = "The Supabase PostgreSQL repository must carry the same ownership marker."
  }
}

run "signing_profile_configuration" {
  command = plan

  assert {
    condition = (
      aws_signer_signing_profile.images.name == "wallie_staging_images" &&
      aws_signer_signing_profile.images.platform_id == "Notation-OCI-SHA384-ECDSA" &&
      one(aws_signer_signing_profile.images.signature_validity_period).value == 1 &&
      one(aws_signer_signing_profile.images.signature_validity_period).type == "YEARS"
    )
    error_message = "Use the fixed OCI signing profile with explicit one-year signature validity."
  }

  assert {
    condition = aws_signer_signing_profile.images.tags == tomap({
      Name        = "wallie_staging_images"
      Project     = "Wallie"
      Environment = "staging"
      ManagedBy   = "Terraform"
      Component   = "signing"
      WallieStack = "wallie-staging-registry"
    })
    error_message = "The signing profile must carry the registry ownership marker and signing metadata."
  }
}

# Mock-generated attributes verify output wiring without creating AWS resources.
run "repository_outputs" {
  command = apply

  assert {
    condition = (
      toset(keys(output.repositories)) == toset(["web", "worker"]) &&
      alltrue([
        for key, repository in output.repositories :
        repository.name == aws_ecr_repository.application[key].name &&
        repository.arn == aws_ecr_repository.application[key].arn &&
        repository.repository_url == aws_ecr_repository.application[key].repository_url &&
        length(repository.arn) > 0 && length(repository.repository_url) > 0
      ])
    )
    error_message = "Outputs must expose the corresponding repository names, ARNs, and image URLs."
  }

  assert {
    condition = (
      output.supabase_postgres_repository.name == aws_ecr_repository.supabase_postgres.name &&
      output.supabase_postgres_repository.arn == aws_ecr_repository.supabase_postgres.arn &&
      output.supabase_postgres_repository.repository_url == aws_ecr_repository.supabase_postgres.repository_url &&
      length(output.supabase_postgres_repository.arn) > 0 &&
      length(output.supabase_postgres_repository.repository_url) > 0
    )
    error_message = "Expose the separate Supabase PostgreSQL repository without changing application outputs."
  }

  assert {
    condition = output.signing_profile == {
      name        = "wallie_staging_images"
      arn         = "arn:aws:signer:us-west-2:123456789012:/signing-profiles/wallie_staging_images"
      version     = "a1b2c3d4e5"
      version_arn = "arn:aws:signer:us-west-2:123456789012:/signing-profiles/wallie_staging_images/a1b2c3d4e5"
      status      = "Active"
    }
    error_message = "Expose the signing profile name, ARN, version identity, and status without mixing fields."
  }
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

run "reject_wrong_caller_account" {
  command = plan
  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "999999999999"
      arn        = "arn:aws:iam::999999999999:user/registry-test"
    }
  }
  expect_failures = [aws_ecr_repository.application, aws_ecr_repository.supabase_postgres, aws_signer_signing_profile.images]
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
  expect_failures = [aws_ecr_repository.application, aws_ecr_repository.supabase_postgres, aws_signer_signing_profile.images]
}
