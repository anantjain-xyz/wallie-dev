output "repositories" {
  description = "Private ECR repositories for later publishing, keyed by web and worker."
  value = {
    for key, repository in aws_ecr_repository.application : key => {
      name           = repository.name
      arn            = repository.arn
      repository_url = repository.repository_url
    }
  }
}

output "supabase_postgres_repository" {
  description = "Private repository reserved for a later verified mirror of the pinned Supabase PostgreSQL image."
  value = {
    name           = aws_ecr_repository.supabase_postgres.name
    arn            = aws_ecr_repository.supabase_postgres.arn
    repository_url = aws_ecr_repository.supabase_postgres.repository_url
  }
}

output "signing_profile" {
  description = "OCI signing profile identity for a later image-signing and verification workflow."
  value = {
    name        = aws_signer_signing_profile.images.name
    arn         = aws_signer_signing_profile.images.arn
    version     = aws_signer_signing_profile.images.version
    version_arn = aws_signer_signing_profile.images.version_arn
    status      = aws_signer_signing_profile.images.status
  }
}
