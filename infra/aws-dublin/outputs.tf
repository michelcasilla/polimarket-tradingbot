output "vpc_id" {
  value       = aws_vpc.main.id
  description = "ID of the project VPC."
}

output "redis_endpoint" {
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
  description = "Primary Redis endpoint (private; only reachable from ECS tasks)."
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecr_repositories" {
  value = { for k, v in aws_ecr_repository.service : k => v.repository_url }
}

output "secrets_arns" {
  value = {
    polygon_private_key = aws_secretsmanager_secret.polygon_private_key.arn
    oracle_api_keys     = aws_secretsmanager_secret.oracle_api_keys.arn
  }
  sensitive = true
}
