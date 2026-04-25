# Bot Strategist

Motor de decisión del ecosistema. Combina señales del Oracle y del Tape Reader para calcular oportunidades y emitir instrucciones de ejecución.

## Responsabilidad
- Consumir `polymarket:book:snapshot:*` y mantener pares YES/NO en memoria.
- Consumir `oracle:signals` (BINANCE/SportRadar/News/Twitter) y mantener el último por topic.
- Ejecutar analizadores (sum-to-one arb, spread capture, news arb) en cada update.
- De-duplicar señales: no re-publica si la misma idea no cambió `fairPrice` por más de `STRATEGIST_DEDUPE_PRICE_EPSILON` dentro de `STRATEGIST_MIN_REPEAT_INTERVAL_MS`.
- Publicar `MarketSignal` validado por Zod en `strategist:signals`.
- (Plan 4) Aplicar límites de riesgo, inventario y circuit breakers; emitir `executor:orders`.

## Analizadores activos
- `SUM_TO_ONE_ARBITRAGE`: si `bestBid(YES) + bestBid(NO) > 1 + edge` (vender ambos) o `bestAsk(YES) + bestAsk(NO) < 1 - edge` (comprar ambos). Emite señales para los dos legs con `metadata.direction = SELL_BOTH | BUY_BOTH` y `metadata.edge`.
- `SPREAD_CAPTURE`: si `spread >= STRATEGIST_SPREAD_MIN`, sugiere `fairPrice = midPrice` para que el ejecutor ponga un Maker Post-Only.
- `NEWS_ARBITRAGE`: cuando llega un `OracleSignal` con `impactScore >= STRATEGIST_NEWS_MIN_IMPACT` y existe un mapping `topic -> marketId` en `STRATEGIST_NEWS_TOPIC_MARKETS`, emite un `MarketSignal` con `fairPrice = mid ± nudge` (`nudge = STRATEGIST_NEWS_FAIR_NUDGE * impactScore`) sesgando hacia YES o NO según la correlación configurada.

## Entradas
- Redis: `polymarket:book:snapshot:*`, `oracle:signals`.
- Config de riesgo (`MAX_CAPITAL_PER_TRADE_USDC`, `DAILY_STOP_LOSS_USDC`).
- Tunables principales:
  - `STRATEGIST_SUM_TO_ONE_EDGE` (default `0.01` = 1¢)
  - `STRATEGIST_SPREAD_MIN` (default `0.04` = 4¢)
  - `STRATEGIST_SIGNAL_TTL_MS` (default `5000`)
  - `STRATEGIST_DEDUPE_PRICE_EPSILON` (default `0.005`)
  - `STRATEGIST_MIN_REPEAT_INTERVAL_MS` (default `500`)
- News-arb:
  - `STRATEGIST_NEWS_MIN_IMPACT` (default `0.4`)
  - `STRATEGIST_NEWS_TTL_MS` (default `8000`)
  - `STRATEGIST_NEWS_FAIR_NUDGE` (default `0.05`)
  - `STRATEGIST_NEWS_TOPIC_MARKETS` (csv `TOPIC:marketId:CORR`, ej. `BTC-USDT:0xMARKET1:POS,ETH-USDT:0xMARKET2:NEG`). Vacío = sólo logging.

## Salidas
- Redis `strategist:signals` con `MarketSignal { marketId, outcome, fairPrice, confidence, reason, ttlMs, metadata }`.
- Logs estructurados `strategist.signal.emitted` con `marketId/outcome/reason/fairPrice/confidence/metadata`.
- `/healthz` con `books`, `snapshotsConsumed`, `oracleConsumed`, `oracleSkipped`, `signalsEmitted`, `signalsSuppressed`, `lastSnapshotAt`, `lastOracleAt`, `lastSignalAt`, `news.{mappings, topics}`.

## Estado actual
Plan 1+3 ejecutando los tres analizadores sobre snapshots reales del CLOB y oracle:signals reales del feed Binance. Plan 4 añadirá inventario, sizing y emisión real de `executor:orders`.

## Ejecutar local
```bash
bun run --cwd apps/bot-strategist dev
```
