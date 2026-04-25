terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Uncomment and fill once an S3+DynamoDB backend is provisioned.
  # backend "s3" {
  #   bucket         = "polymarket-hft-tfstate"
  #   key            = "aws-dublin/terraform.tfstate"
  #   region         = "eu-west-1"
  #   dynamodb_table = "polymarket-hft-tflock"
  #   encrypt        = true
  # }
}
