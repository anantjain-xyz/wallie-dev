variable "aws_account_id" {
  description = "Expected AWS account; the provider refuses credentials for another account."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be the expected 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "Commercial AWS region matching the state backend and deployment policy."
  type        = string
  default     = "us-west-2"
  nullable    = false

  validation {
    condition = (
      can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.aws_region)) &&
      !startswith(var.aws_region, "cn-")
    )
    error_message = "aws_region must be a commercial AWS region name; other partitions are not qualified."
  }
}
