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
