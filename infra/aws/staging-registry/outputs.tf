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
