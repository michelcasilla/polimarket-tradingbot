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
  - `polymarket:book:snapshot:*`
  - `polymarket:book:delta:*`

## Salidas
- WebSocket `ws://localhost:7010/ws`.
- HTTP status `http://localhost:7010/status`.
- Health endpoint en `HEALTH_PORT_DASHBOARD_GATEWAY`.

## Estado actual
Implementado como gateway funcional para streaming del dashboard (MVP Plan 6).

## Ejecutar local
```bash
bun run --cwd apps/dashboard-gateway dev
```
