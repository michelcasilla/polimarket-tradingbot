# Bot Tape Reader

Servicio de lectura del CLOB de Polymarket. Mantiene una vista del order book en tiempo real y la distribuye al resto del sistema.

## Responsabilidad
- Polleo del CLOB de Polymarket vía REST (`/sampling-markets`, `/book`).
- Auto-descubre los top N mercados binarios YES/NO (o usa una lista manual).
- Construye `OrderBookSnapshot` (top de bid/ask, mid, spread, profundidad).
- Publica cada snapshot en Redis con validación Zod.
- Expone health checks con métricas operativas (poll counter, errores, last success).

## Entradas
- `POLYMARKET_CLOB_HTTP_URL` (default `https://clob.polymarket.com`).
- `TAPE_READER_TOKEN_IDS` (opcional): lista manual `tokenId:YES@conditionId,...`.
- `TAPE_READER_AUTO_DISCOVER_LIMIT` (default `5`): cantidad de mercados a descubrir.
- `TAPE_READER_POLL_INTERVAL_MS` (default `3000`).
- `TAPE_READER_MAX_LEVELS` (default `15`): profundidad por lado.
- `REDIS_URL` para distribución interna.

## Salidas
- Redis `polymarket:book:snapshot:<conditionId>:<YES|NO>`.
- Redis `polymarket:book:delta:*` (Plan 2: WebSocket).
- Logs estructurados JSON.
- Health endpoint en `HEALTH_PORT_TAPE_READER` (`/healthz` incluye `tokensTracked`, `pollSuccesses`, `pollErrors`, `lastSuccessAt`).

## Estado actual
Plan 1: REST polling productivo. Plan 2: migración a WebSocket CLOB con deltas y reconciliación de secuencia.

## Ejecutar local
```bash
bun run --cwd apps/bot-tape-reader dev
```
