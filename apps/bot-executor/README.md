# Bot Executor

Único servicio que tiene "permiso" para colocar órdenes. Consume `executor:orders` / `executor:cancels`, decide qué pasa con cada una y publica el resultado en `executor:results`.

## Modos

| Modo | `EXECUTOR_MODE` | Qué hace | Requiere |
|---|---|---|---|
| Simulation (default) | `simulation` | Motor en memoria que cachea snapshots L2 (`polymarket:book:snapshot:*`) y simula `FILLED` / `PLACED` / `EXPIRED` / `REJECTED` con fees configurables. Sin acceso a chain. | Nada extra |
| Live (stub seguro) | `live` | Reservado para la firma real Polymarket CLOB. Hoy rechaza cada orden con `live_mode_not_yet_implemented` para que ningún error de configuración mueva fondos accidentalmente. | `POLYGON_PRIVATE_KEY` ≥ 64 chars |

## Modelo del simulador

1. **Risk envelope** (antes de tocar el book):
   - Notional cap → `price * size > MAX_CAPITAL_PER_TRADE_USDC` ⇒ `REJECTED notional_exceeds`.
   - Cap de órdenes abiertas (`EXECUTOR_MAX_OPEN_ORDERS`) ⇒ `REJECTED open_orders_cap`.
   - Circuit-breaker activo ⇒ `REJECTED circuit_breaker_active` (estado se publica también en `system:circuit-breaker`).
2. **Decisión de fill**:
   - Sin libro disponible → `PLACED` y queda residente hasta tener snapshot o agotar TTL.
   - Cruza spread + `postOnly=true` ⇒ `REJECTED post_only_would_cross` (protege Maker Rewards).
   - Cruza spread + `postOnly=false` ⇒ primero `PLACED`, luego `FILLED` (taker fee) tras una latencia sintética (`EXECUTOR_LATENCY_MIN_MS` + jitter).
   - No cruza ⇒ `PLACED`. En cada nuevo snapshot el motor barre la cola: si ahora cruzaría se emite `FILLED` con maker fee.
3. **TTL y cancel**:
   - `ttlMs` opcional por orden o `EXECUTOR_DEFAULT_TTL_MS` ⇒ `EXPIRED`.
   - `executor:cancels` con orderId conocido ⇒ `CANCELLED`.
4. **Daily stop**:
   - Acumula fees como aproximación pesimista de PnL. Si `-pnl >= DAILY_STOP_LOSS_USDC` ⇒ flag `circuit_breaker_active`, dispara `system:circuit-breaker` una vez y rechaza órdenes posteriores hasta reiniciar el proceso.

## Entradas

- Redis (sub):
  - `executor:orders` → `ExecutionOrder`
  - `executor:cancels` → `CancelOrder`
  - `executor:control` → `ExecutorControlCommand` (`PAUSE` / `RESUME`) desde dashboard-gateway
  - `polymarket:book:snapshot:*` → `OrderBookSnapshot` (solo modo simulation)
- Env: ver tabla abajo.

## Control / pausa (dashboard)

- **`PAUSE`** (publicado por el gateway como respuesta al botón “Panic”): bandera en memoria `paused`; todas las órdenes nuevas reciben `REJECTED` con `executor_paused`. En **simulation**, además se cancelan todas las órdenes residentes (`PLACED`) y cada resultado lleva `error: executor_paused`.
- **`RESUME`**: quita la pausa; no re-hidrata órdenes canceladas.
- El estado se publica en **`system:executor-control`** (`ExecutorStatusEvent`) en cada transición y cada ~5s (heartbeat). El flag **no persiste**: reiniciar el proceso lo pierde (como el circuit breaker).
- **Limitación**: una orden taker con `PLACED` → `FILLED` diferido (`setTimeout`) puede seguir completándose tras el pánico; solo las órdenes en el mapa `open` del simulador se cancelan.

## Salidas

- Redis (pub):
  - `executor:results` → `ExecutionResult`
  - `system:circuit-breaker` → `CircuitBreakerEvent` cuando se dispara el daily stop.
  - `system:executor-control` → estado de pausa / heartbeat (`ExecutorStatusEvent`)
- HTTP `:7004`:
  - `/healthz` con `mode`, contadores del simulador (received/accepted/filled/rejected/cancelled/expired), libros cacheados, fees y PnL estimado, descriptor del adapter live cuando aplique.

## Variables relevantes

| Var | Default | Descripción |
|---|---|---|
| `EXECUTOR_MODE` | `simulation` | `simulation` \| `live` |
| `MAX_CAPITAL_PER_TRADE_USDC` | `50` | Notional cap por orden |
| `DAILY_STOP_LOSS_USDC` | `100` | Disparo del circuit breaker |
| `EXECUTOR_TAKER_FEE_BPS` | `20` | Fee aplicada a fills inmediatos (taker) |
| `EXECUTOR_MAKER_FEE_BPS` | `0` | Fee aplicada a fills resting (maker) |
| `EXECUTOR_DEFAULT_TTL_MS` | `15000` | TTL si la orden no trae `ttlMs` |
| `EXECUTOR_MAX_OPEN_ORDERS` | `200` | Cap de órdenes residentes |
| `EXECUTOR_LATENCY_MIN_MS` | `50` | Latencia sintética mínima del fill |
| `EXECUTOR_LATENCY_JITTER_MS` | `250` | Jitter sobre la latencia mínima |
| `EXECUTOR_SWEEP_INTERVAL_MS` | `1000` | Frecuencia del barrido para TTL/maker fills |
| `POLYGON_PRIVATE_KEY` | – | Solo modo live; ≥ 64 chars hex |

## Verificación rápida (simulation)

```bash
docker compose up -d --build bot-executor

# Inyectar una orden de prueba:
docker exec polymarket-redis redis-cli PUBLISH executor:orders '{
  "id":"test-1","marketId":"0xdemo","assetId":"asset-demo","outcome":"YES",
  "side":"BUY","price":0.55,"size":10,"type":"LIMIT","timeInForce":"GTC",
  "postOnly":true,"createdAt":1
}'

# Observar el resultado:
docker exec polymarket-redis redis-cli SUBSCRIBE executor:results
```

## Seguridad

- En producción, `POLYGON_PRIVATE_KEY` debe venir de Secrets Manager / Parameter Store, nunca del repo.
- El proceso es el ÚNICO autorizado a tener acceso a la key. El strategist nunca firma.

## Ejecutar local

```bash
bun run --cwd apps/bot-executor dev
```
