variable "aws_region" {
  description = "AWS region. Must remain eu-west-1 for the latency-to-Polymarket guarantee."
  type        = string
  default     = "eu-west-1"
}

variable "project_name" {
  description = "Project name used as prefix for every resource."
  type        = string
  default     = "polymarket-hft"
}

variable "environment" {
  description = "Deployment environment."
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of dev | staging | prod"
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "AZs for subnets. Two AZs are sufficient (Fargate + ElastiCache)."
  type        = list(string)
  default     = ["eu-west-1a", "eu-west-1b"]
}

variable "redis_node_type" {
  description = "ElastiCache Redis node type. r7g recommended for low-latency in-memory order book."
  type        = string
  default     = "cache.r7g.large"
}

variable "ecs_services" {
  description = "Mapping of bot logical name -> Fargate sizing."
  type = map(object({
    cpu              = number
    memory           = number
    desired_count    = number
    health_port      = number
    container_port   = number
    needs_public_lb  = bool
  }))
  default = {
    bot-oracle = {
      cpu             = 512
      memory          = 1024
      desired_count   = 1
      health_port     = 7001
      container_port  = 7001
      needs_public_lb = false
    }
    bot-tape-reader = {
      cpu             = 1024
      memory          = 2048
      desired_count   = 1
      health_port     = 7002
      container_port  = 7002
      needs_public_lb = false
    }
    bot-strategist = {
      cpu             = 1024
      memory          = 2048
      desired_count   = 1
      health_port     = 7003
      container_port  = 7003
      needs_public_lb = false
    }
    bot-executor = {
      cpu             = 1024
      memory          = 2048
      desired_count   = 1
      health_port     = 7004
      container_port  = 7004
      needs_public_lb = false
    }
    dashboard-gateway = {
      cpu             = 512
      memory          = 1024
      desired_count   = 1
      health_port     = 7005
      container_port  = 7005
      needs_public_lb = true
    }
  }
}

variable "image_tag" {
  description = "Default image tag pulled from ECR for every service."
  type        = string
  default     = "latest"
}

variable "log_retention_days" {
  description = "CloudWatch log retention per service."
  type        = number
  default     = 30
}
