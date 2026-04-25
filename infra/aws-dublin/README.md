# AWS Dublín (eu-west-1) — Infraestructura

Skeleton Terraform para desplegar el ecosistema Polymarket HFT en `eu-west-1`. La elección de región es estratégica: Polymarket aloja su motor CLOB en `eu-west-2` (Londres). Dublín está físicamente cerca (~1ms de latencia) sin caer bajo las restricciones regulatorias del Reino Unido. Ver [Arquitectura — sección 3](../../docs/Arquitectura%20Completa%20y%20Estrategia%20Maestra_%20Bot%20Polymarket%20v1.1%20%28Full%29.docx).

## Estructura

```
infra/aws-dublin/
  versions.tf       # Terraform / provider pinning
  providers.tf      # AWS provider + default tags
  variables.tf      # Inputs
  main.tf           # VPC, ECS cluster, ElastiCache Redis, ECR, Secrets Manager
  ecr.tf            # 5 repositorios (uno por imagen)
  ecs-services.tf   # Definiciones de tarea + servicios para los 5 bots
  outputs.tf
  terraform.tfvars.example
```

## Estado actual

**Esqueleto** — define recursos pero no se aplica todavía. Para el primer despliegue real (Plan 5/6 ya estables) será necesario:

1. Crear bucket S3 + DynamoDB lock para backend remoto.
2. Subir imágenes Docker a los 5 repos ECR.
3. Sembrar secretos en Secrets Manager (Polygon private key, API keys de oráculos).
4. `terraform init && terraform plan && terraform apply`.

## Recursos provisionados

| Recurso                                       | Notas                                                             |
| --------------------------------------------- | ----------------------------------------------------------------- |
| VPC `/16` con 2 subnets privadas + 2 públicas | Multi-AZ en `eu-west-1a/b`                                        |
| NAT Gateway                                   | Egress controlado para Secrets Manager / RPC                      |
| ECS Cluster Fargate                           | 5 servicios (uno por app)                                         |
| ElastiCache Redis                             | `cache.r7g.large`, single-node, en subnet privada                 |
| ECR                                           | 5 repositorios con scan-on-push                                   |
| Secrets Manager                               | `polymarket/polygon-private-key`, `polymarket/api-keys`           |
| CloudWatch Logs                               | 30 días retención por servicio                                    |
| IAM                                           | Roles scoped por servicio (sólo Executor accede a la private key) |

## Variables principales

Ver `terraform.tfvars.example`. Mínimo necesario:

- `aws_region` (default `eu-west-1`)
- `project_name` (default `polymarket-hft`)
- `environment` (`dev` | `staging` | `prod`)
- `redis_node_type`
- `image_tags` por servicio
