variable "aws_account_id" {
  description = "Expected non-root AWS account for the staging host."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "Commercial AWS region containing the staging VPC and pinned AMI."
  type        = string
  default     = "us-west-2"
  nullable    = false

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.aws_region)) && !startswith(var.aws_region, "cn-")
    error_message = "aws_region must be a commercial AWS region."
  }
}

variable "vpc_id" {
  description = "Reviewed wallie-staging VPC ID."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^vpc-[0-9a-f]+$", var.vpc_id))
    error_message = "vpc_id must be an EC2 VPC ID."
  }
}

variable "database_subnet_id" {
  description = "Reviewed database-a subnet ID; never use a public or service subnet."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^subnet-[0-9a-f]+$", var.database_subnet_id))
    error_message = "database_subnet_id must be an EC2 subnet ID."
  }
}

variable "database_security_group_id" {
  description = "Reviewed self-hosted Supabase database SG from the network stack."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^sg-[0-9a-f]+$", var.database_security_group_id))
    error_message = "database_security_group_id must be an EC2 security group ID."
  }
}

variable "ami_id" {
  description = "Exact regional Amazon Linux 2023 x86-64 AMI ID, reviewed and pinned before planning."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ami-[0-9a-f]+$", var.ami_id))
    error_message = "ami_id must be an exact regional AMI ID."
  }
}

variable "ebs_kms_key_arn" {
  description = "Reviewed same-account, same-region customer-managed EBS KMS key ARN for both root and persistent data volumes."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^arn:aws:kms:${var.aws_region}:${var.aws_account_id}:key/(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|mrk-[0-9a-f]{32})$", var.ebs_kms_key_arn))
    error_message = "ebs_kms_key_arn must be an exact KMS key ARN in the expected account and region."
  }
}

variable "instance_type" {
  description = "Reviewed x86-64 Nitro instance size for first-AZ staging qualification."
  type        = string
  default     = "t3.large"
  nullable    = false

  validation {
    condition     = contains(["t3.large", "m6i.large", "m7i.large"], var.instance_type)
    error_message = "instance_type must be a reviewed x86-64 Nitro size."
  }
}

variable "data_volume_gib" {
  description = "Dedicated encrypted gp3 volume size; increasing requires an independent database capacity review."
  type        = number
  default     = 100
  nullable    = false

  validation {
    condition     = var.data_volume_gib >= 100 && var.data_volume_gib <= 1024 && floor(var.data_volume_gib) == var.data_volume_gib
    error_message = "data_volume_gib must be an integer between 100 and 1024."
  }
}
