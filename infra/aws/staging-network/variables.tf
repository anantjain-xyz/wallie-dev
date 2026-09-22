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
  description = "AWS region matching the state backend and the deployment policy."
  type        = string
  default     = "us-west-2"
  nullable    = false

  validation {
    condition     = can(regex("^([a-z]{2}-[a-z]+|us-gov-[a-z]+)-[0-9]+$", var.aws_region))
    error_message = "aws_region must be a standard commercial, China, or GovCloud region name."
  }
}

variable "availability_zones" {
  description = "Two distinct standard Availability Zones, in stable a/b slot order."
  type        = list(string)
  nullable    = false

  validation {
    condition = (
      length(var.availability_zones) == 2 &&
      length(distinct(var.availability_zones)) == 2 &&
      alltrue([for zone in var.availability_zones : can(regex("^${var.aws_region}[a-z]$", zone))])
    )
    error_message = "availability_zones must contain two distinct standard AZ names in aws_region."
  }
}

variable "vpc_cidr" {
  description = "An aligned private IPv4 /16, selected after checking existing and connected networks."
  type        = string
  default     = "10.42.0.0/16"
  nullable    = false

  validation {
    condition = (
      can(regex("^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)", var.vpc_cidr)) &&
      try(
        cidrnetmask(var.vpc_cidr) == "255.255.0.0" &&
        cidrhost(var.vpc_cidr, 0) == split("/", var.vpc_cidr)[0],
        false
      )
    )
    error_message = "vpc_cidr must be an aligned RFC 1918 IPv4 /16, such as 10.42.0.0/16."
  }
}

variable "enable_private_connectivity" {
  description = "Create the separately reviewed, billable application endpoints and dedicated security groups. Keep false during foundation/hardening."
  type        = bool
  default     = false
  nullable    = false
}
