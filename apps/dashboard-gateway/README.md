# Dashboard Gateway

Puente entre el bus interno (Redis Pub/Sub) y la interfaz web del dashboard. Expone WebSocket para streaming en tiempo real.

## Responsabilidad
- Suscribirse a canales internos Redis.
- Reemitir eventos al frontend vía WebSocket.
- Entregar endpoint de estado y health checks.

## Entradas
- Redis channels:
  - `system:health`
  - `oracle:signals`
  - `strategist:signals`
  - `executor:results`
  - `system:circuit-breaker`
  - `system:executor-control`
  - `polymarket:markets:metadata`
  - `polymarket:book:snapshot:*`
  - `polymarket:book:delta:*`

## Salidas
- WebSocket `ws://localhost:7010/ws`.
- HTTP status `http://localhost:7010/status`.
- Health endpoint en `HEALTH_PORT_DASHBOARD_GATEWAY`.

## Control endpoints (executor)

POST bodies use JSON where noted. CORS `*` is enabled for `/control/*` so the Vite dev server can call the gateway on another origin.

| Method | Path | Body | Effect |
|--------|------|------|--------|
| POST | `/control/executor/panic` | — | Publish `executor:control` `{ type: PAUSE }` |
| POST | `/control/executor/resume` | — | Publish `executor:control` `{ type: RESUME }` |
| POST | `/control/executor/orders/:orderId/cancel` | `{ "marketId": "<condition id>" }` | Publish `executor:cancels` with `reason: DASHBOARD` |

**Security:** no authentication on these routes; do not expose the gateway port to the public internet without a reverse proxy and auth.

## Estado actual
Implementado como gateway funcional para streaming del dashboard (MVP Plan 6).

## Ejecutar local
```bash
bun run --cwd apps/dashboard-gateway dev
```
