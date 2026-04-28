# Polymarket HFT Trading Bot

Ecosistema multi-agente de alta frecuencia para Polymarket sobre la red Polygon. Compuesto por 4 bots independientes (Oracle, Tape Reader, Estratega, Ejecutor) más un dashboard de control en React + Ant Design.

> **Filosofía** (Regla de Oro): el dinero no se gana prediciendo el futuro, sino corrigiendo los errores de precio que cometen otros participantes.

## Arquitectura

Ver [docs/Arquitectura Completa y Estrategia Maestra\_ Bot Polymarket v1.1 (Full).docx](docs/Arquitectura%20Completa%20y%20Estrategia%20Maestra_%20Bot%20Polymarket%20v1.1%20%28Full%29.docx).

```
apps/
  bot-oracle/          External news/events ingestor (Binance, Sportradar, news feeds)
  bot-tape-reader/     Polymarket CLOB WebSocket -> Redis order book
  bot-strategist/      Decision engine (fair price, spread score, arbitrage)
  bot-executor/        Polygon transaction signer + order lifecycle
  dashboard-gateway/   Bridge WS dashboard <-> Redis
  dashboard/           React + Ant Design SPA (Plan 6)
packages/
  contracts/           Tipos compartidos (zod) + canales Redis tipados
  bus/                 Wrapper Redis Pub/Sub tipado
  logger/              pino con redacción de claves
  config/              Carga de env con validación zod
  health/              Endpoints /healthz y /readyz reusables
infra/
  aws-dublin/          Skeleton Terraform para eu-west-1
  docker/              Dockerfiles multi-stage
```

## Stack técnico

| Capa       | Elección                   | Motivo                                     |
| ---------- | -------------------------- | ------------------------------------------ |
| Runtime    | **Bun** ≥ 1.1              | I/O de alto rendimiento, soporte nativo TS |
| Lenguaje   | **TypeScript strict**      | Sin `any`, contratos seguros               |
| WebSockets | **uWebSockets.js**         | Latencia sub-ms, evita el overhead de `ws` |
| Mensajería | **Redis Pub/Sub**          | Comunicación inter-bot sub-ms              |
| Validación | **zod**                    | Runtime + compile-time type safety         |
| Logging    | **pino**                   | Redacción automática de claves privadas    |
| Infra      | **AWS Dublín (eu-west-1)** | ~1ms al motor CLOB de Polymarket           |

## Requisitos

- [Bun](https://bun.sh/) ≥ 1.1
- [Docker](https://www.docker.com/) + Docker Compose (para Redis local)
- (Opcional) [Terraform](https://www.terraform.io/) ≥ 1.6 para deploy a AWS

## Instalación

```bash
bun install
cp .env.example .env
docker compose up redis -d
bun run typecheck
bun run lint
bun test
```

## Desarrollo local

```bash
docker compose up --build
```

Levanta Redis + los 4 bots + `dashboard-gateway` (WebSocket en el host, p. ej. puerto **7010**). El contenedor **nginx** del dashboard estático (puerto **8080**) no arranca por defecto; para esa build de producción usa `docker compose --profile static up --build`.

**Live reload (Vite):** con el stack arriba, en otra terminal:

```bash
bun run dev:dashboard
```

Abre **http://localhost:5173** (HMR). Equivale a `bun run --cwd apps/dashboard dev`.

## Go-Live runbook (executor)

1. Set `EXECUTOR_MODE=live` and keep `EXECUTOR_LIVE_DRY_RUN=true`.
2. Run at least 24h in dry-run and verify:
   - `executor:reconciliation` has no sustained drift
   - `executor:positions` updates are coherent with fills
3. Switch to real posting with very low limits:
   - `EXECUTOR_LIVE_DRY_RUN=false`
   - `MAX_CAPITAL_PER_TRADE_USDC=5`
   - `DAILY_STOP_LOSS_USDC=10`
4. Observe 48h before scaling risk limits upward.

## Deploy a AWS Dublín

Skeleton en `infra/aws-dublin/`. Ver [`infra/aws-dublin/README.md`](infra/aws-dublin/README.md).

## Roadmap

| Plan                                 | Estado      |
| ------------------------------------ | ----------- |
| 1. Infraestructura, contratos y CI   | en progreso |
| 2. Bot Tape Reader (Polymarket CLOB) | pendiente   |
| 3. Bot Oracle (News/Events)          | pendiente   |
| 4. Bot Estratega (Brain)             | pendiente   |
| 5. Bot Ejecutor (Polygon TX)         | pendiente   |
| 6. Dashboard React + Ant Design      | pendiente   |

## Licencia

Privado. No publicar.
