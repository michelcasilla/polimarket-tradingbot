# Calibration 2026 Q2

This document tracks parameter calibration for the live executor + strategist stack.

## Dataset Plan

- Source: `book:snapshot` stream recorded into NDJSON using `@polymarket-bot/backtest` recorder.
- Horizon: 7 consecutive days.
- Markets: at least 3 liquid markets with stable metadata.

## Parameter Grid

- `STRATEGIST_SUM_TO_ONE_EDGE`: `0.005`, `0.01`, `0.02`, `0.05`
- `STRATEGIST_SPREAD_MIN`: `0.01`, `0.02`, `0.03`
- `STRATEGIST_INVENTORY_SKEW_BPS`: `25`, `50`, `100`

## Evaluation Metrics

- Net PnL (USDC)
- Max drawdown
- Fill ratio
- Adverse-selection ratio
- Expected maker-reward score

## Selected Set

Pending data collection.

## Runbook

1. Record snapshots to NDJSON for 7 days.
2. Replay via:
   - `bun run --cwd packages/backtest backtest --file <snapshots.ndjson>`
3. Export result JSON.
4. Choose Pareto-optimal tuple (PnL vs drawdown).
