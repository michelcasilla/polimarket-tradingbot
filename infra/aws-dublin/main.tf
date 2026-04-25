locals {
  name_prefix = "${var.project_name}-${var.environment}"
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-igw" }
}

resource "aws_subnet" "public" {
  for_each = { for i, az in var.availability_zones : az => i }

  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, each.value)
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name_prefix}-public-${each.key}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  for_each = { for i, az in var.availability_zones : az => i }

  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, each.value + 100)

  tags = {
    Name = "${local.name_prefix}-private-${each.key}"
    Tier = "private"
  }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name_prefix}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = values(aws_subnet.public)[0].id
  tags          = { Name = "${local.name_prefix}-nat" }

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${local.name_prefix}-rt-public" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "${local.name_prefix}-rt-private" }
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

resource "aws_security_group" "ecs_tasks" {
  name        = "${local.name_prefix}-ecs-tasks"
  description = "Egress for bot containers; intra-cluster ingress only."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Intra-VPC traffic between bots and ALB"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "All egress (Polymarket WS, Polygon RPC, Binance...)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-ecs-tasks" }
}

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis"
  description = "ElastiCache Redis — only ECS tasks can talk to it."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from ECS tasks"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-redis" }
}

# ---------------------------------------------------------------------------
# ElastiCache Redis (in-memory order book + Pub/Sub bus)
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis"
  subnet_ids = [for s in aws_subnet.private : s.id]
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "Polymarket HFT bus + order book"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1
  parameter_group_name       = "default.redis7"
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  automatic_failover_enabled = false
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # keep TLS off intra-VPC for sub-ms latency
  apply_immediately          = true

  tags = { Name = "${local.name_prefix}-redis" }
}

# ---------------------------------------------------------------------------
# Secrets Manager — only the Executor IAM role gets read access (see ecs-services.tf)
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "polygon_private_key" {
  name        = "${local.name_prefix}/polygon-private-key"
  description = "Polygon EOA private key used by bot-executor. NEVER attach to other roles."
}

resource "aws_secretsmanager_secret" "oracle_api_keys" {
  name        = "${local.name_prefix}/oracle-api-keys"
  description = "Sportradar / NewsAPI / Twitter API keys for bot-oracle."
}

# ---------------------------------------------------------------------------
# ECS cluster
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch log groups (one per service)
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "service" {
  for_each          = var.ecs_services
  name              = "/ecs/${local.name_prefix}/${each.key}"
  retention_in_days = var.log_retention_days
}
