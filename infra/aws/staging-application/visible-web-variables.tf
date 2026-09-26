variable "enable_visible_web" {
  description = "Opt in to a staging-only HTTPS ALB and zero-task ECS web service."
  type        = bool
  default     = false
  nullable    = false
}

variable "request_web_certificate" {
  description = "Request a staging ACM certificate; external DNS validation is a separate manual step."
  type        = bool
  default     = false
  nullable    = false

  validation {
    condition     = !var.enable_visible_web || var.request_web_certificate
    error_message = "Visible web requires the previously requested staging certificate."
  }
}

variable "web_desired_count" {
  description = "Start with zero, then explicitly raise to one after secret, image, and task-definition review."
  type        = number
  default     = 0
  nullable    = false

  validation {
    condition     = contains([0, 1], var.web_desired_count) && (var.enable_visible_web || var.web_desired_count == 0)
    error_message = "Web desired count must be zero or one and requires visible web to be enabled."
  }
}

variable "web_hostname" {
  description = "Fixed staging hostname; production wallie.dev is never managed here."
  type        = string
  default     = "aws-staging.wallie.dev"
  nullable    = false

  validation {
    condition     = var.web_hostname == "aws-staging.wallie.dev"
    error_message = "Only aws-staging.wallie.dev is qualified."
  }
}

variable "web_validated_certificate_arn" {
  description = "Exact ACM certificate ARN after external DNS validation and ISSUED readback."
  type        = string
  default     = null

  validation {
    condition = !var.enable_visible_web || can(regex(
      "^arn:aws:acm:${var.aws_region}:${var.aws_account_id}:certificate/[a-f0-9-]{36}$",
      var.web_validated_certificate_arn,
    ))
    error_message = "Visible web requires the exact issued staging ACM certificate ARN."
  }
}

variable "web_vpc_id" {
  description = "VPC ID from the reviewed staging-network Terraform output."
  type        = string
  default     = null

  validation {
    condition     = !var.enable_visible_web || can(regex("^vpc-[a-f0-9]{8,17}$", var.web_vpc_id))
    error_message = "Enabled web requires the reviewed VPC ID."
  }
}

variable "web_public_subnet_ids" {
  description = "Exactly the public-a and public-b subnet IDs from the network output."
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition = !var.enable_visible_web || (
      toset(keys(var.web_public_subnet_ids)) == toset(["a", "b"]) &&
      length(distinct(values(var.web_public_subnet_ids))) == 2 &&
      alltrue([for id in values(var.web_public_subnet_ids) : can(regex("^subnet-[a-f0-9]{8,17}$", id))])
    )
    error_message = "Enabled web requires distinct public-a and public-b subnet IDs."
  }
}

variable "web_service_subnet_id" {
  description = "Private services-a subnet ID with the reviewed HTTPS NAT route."
  type        = string
  default     = null

  validation {
    condition     = !var.enable_visible_web || can(regex("^subnet-[a-f0-9]{8,17}$", var.web_service_subnet_id))
    error_message = "Enabled web requires the services-a subnet ID."
  }
}

variable "web_egress_security_group_ids" {
  description = "Exactly the existing application-tasks and runtime-egress security groups, in that order."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition = !var.enable_visible_web || (
      length(var.web_egress_security_group_ids) == 2 &&
      length(distinct(var.web_egress_security_group_ids)) == 2 &&
      alltrue([for id in var.web_egress_security_group_ids : can(regex("^sg-[a-f0-9]{8,17}$", id))])
    )
    error_message = "Enabled web requires the two reviewed private-task egress security groups."
  }
}

variable "web_task_definition_arn" {
  description = "Exact read-back verified hosted-web task-definition revision; no floating family or tag."
  type        = string
  default     = null

  validation {
    condition = !var.enable_visible_web || can(regex(
      "^arn:aws:ecs:${var.aws_region}:${var.aws_account_id}:task-definition/wallie-staging-web-app:[1-9][0-9]*$",
      var.web_task_definition_arn,
    ))
    error_message = "Enabled web requires one exact staging web task-definition revision ARN."
  }
}
