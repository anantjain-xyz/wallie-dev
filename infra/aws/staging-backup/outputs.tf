output "backup_bucket" {
  description = "Empty PostgreSQL backup destination; uploads are blocked pending recovery controls."
  value = {
    name = aws_s3_bucket.postgres_backups.id
    arn  = aws_s3_bucket.postgres_backups.arn
  }
}
