# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name_prefix}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Per-service task role (so we can scope secrets only to bot-executor / bot-oracle)
resource "aws_iam_role" "task" {
  for_each           = var.ecs_services
  name               = "${local.name_prefix}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "executor_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.polygon_private_key.arn]
  }
}

data "aws_iam_policy_document" "oracle_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [aws_secretsmanager_secret.oracle_api_keys.arn]
  }
}

resource "aws_iam_role_policy" "executor_secrets" {
  name   = "${local.name_prefix}-executor-secrets"
  role   = aws_iam_role.task["bot-executor"].id
  policy = data.aws_iam_policy_document.executor_secrets.json
}

resource "aws_iam_role_policy" "oracle_secrets" {
  name   = "${local.name_prefix}-oracle-secrets"
  role   = aws_iam_role.task["bot-oracle"].id
  policy = data.aws_iam_policy_document.oracle_secrets.json
}

# ---------------------------------------------------------------------------
# Task definitions
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "service" {
  for_each = var.ecs_services

  family                   = "${local.name_prefix}-${each.key}"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.service[each.key].repository_url}:${var.image_tag}"
      essential = true
      portMappings = [
        {
          containerPort = each.value.container_port
          protocol      = "tcp"
        }
      ]
      environment = [
        { name = "NODE_ENV", value = var.environment == "prod" ? "production" : var.environment },
        { name = "REDIS_URL", value = "redis://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379" },
        { name = "HEALTH_PORT", value = tostring(each.value.health_port) },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O- http://127.0.0.1:${each.value.health_port}/healthz >/dev/null || exit 1"]
        interval    = 15
        timeout     = 3
        retries     = 3
        startPeriod = 20
      }
    }
  ])
}

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "service" {
  for_each = var.ecs_services

  name            = "${local.name_prefix}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [for s in aws_subnet.private : s.id]
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_controller {
    type = "ECS"
  }

  lifecycle {
    ignore_changes = [desired_count]
  }
}
