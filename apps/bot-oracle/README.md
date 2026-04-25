# Bot Oracle

Servicio de ingesta de señales externas (precios de exchanges, news, eventos). Su responsabilidad es detectar movimientos significativos fuera de Polymarket y notificárselos al Estratega para que evalúe arbitrajes informativos.

## Responsabilidades
- Mantener conexiones WebSocket a feeds externos (Plan 1: Binance; futuros planes añaden SportRadar, NewsAPI y Twitter).
- Normalizar las señales al contrato `OracleSignal` (`provider`, `eventType`, `topic`, `impactScore`, `rawData`).
- Publicar en Redis (`oracle:signals`) sólo cuando se cruza un umbral relevante (no inundar al Estratega).
- Exponer `/healthz` y `/readyz` con stats por proveedor.

## Proveedor activo: Binance
- Endpoint: `wss://stream.binance.com:9443/stream?streams=<symbol>@ticker/...`
- Mantiene una ventana deslizante de precios por símbolo (`ORACLE_BINANCE_WINDOW_MS`).
- Emite `OracleSignal` `PRICE_DELTA` cuando `|delta%| >= ORACLE_BINANCE_MIN_DELTA_PCT` y han pasado al menos `ORACLE_BINANCE_COOLDOWN_MS` desde la última emisión por símbolo.
- `impactScore` se normaliza a `[0,1]` usando `ORACLE_BINANCE_SATURATION_PCT` (saturación = 1.0).
- Topic: `BTCUSDT` -> `BTC-USDT`, etc.

## Entradas
- Variables comunes: `REDIS_URL`, `LOG_LEVEL`, `NODE_ENV`.
- Variables Binance:
  - `BINANCE_WS_URL` (default `wss://stream.binance.com:9443/ws`)
  - `ORACLE_BINANCE_ENABLED` (`true`/`false`)
  - `ORACLE_BINANCE_SYMBOLS` (csv lowercase, default `btcusdt,ethusdt,solusdt`)
  - `ORACLE_BINANCE_WINDOW_MS` (default `60000`)
  - `ORACLE_BINANCE_MIN_DELTA_PCT` (default `0.5`)
  - `ORACLE_BINANCE_SATURATION_PCT` (default `2.5`)
  - `ORACLE_BINANCE_COOLDOWN_MS` (default `5000`)
- Salud: `HEALTH_PORT_ORACLE` (default `7001`).

## Salidas
- Canal Redis `oracle:signals` (validado por `OracleSignalSchema`).
- Logs estructurados JSON (Pino).
- Health endpoints (`/healthz`, `/readyz`) en `HEALTH_PORT_ORACLE`.

## Estado actual
Plan 3 inicial: feed Binance funcionando. Pendiente: SportRadar, NewsAPI, Twitter; backpressure cross-provider; persistence opcional.

## Ejecutar local
```bash
bun run --cwd apps/bot-oracle dev
```

## Verificación rápida
```bash
# Salud
curl -s http://localhost:7001/healthz | jq

# Escuchar señales emitidas
redis-cli SUBSCRIBE oracle:signals
```
