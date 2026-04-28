import { Channels, type AdverseSelectionEvent, type CircuitBreakerEvent, type Fill } from '@polymarket-bot/contracts';
import type { MessageBus } from '@polymarket-bot/bus';
import type { Logger } from '@polymarket-bot/logger';

export interface AdverseSelectionConfig {
  bus: MessageBus;
  logger: Logger;
  horizonMs: number;
  threshold: number;
  minSamples: number;
  getMidPrice: (marketId: string, outcome: 'YES' | 'NO') => number | null;
}

interface Bucket {
  total: number;
  wrongSide: number;
}

export const createAdverseSelectionDetector = (cfg: AdverseSelectionConfig) => {
  const buckets = new Map<string, Bucket>();

  const ingestFill = (fill: Fill, midAtFill: number): void => {
    setTimeout(() => {
      const midAtTPlus = cfg.getMidPrice(fill.marketId, fill.outcome);
      if (midAtTPlus === null) return;
      const wrongSide =
        (fill.side === 'BUY' && midAtTPlus < fill.price) ||
        (fill.side === 'SELL' && midAtTPlus > fill.price);
      const signedDriftBps =
        ((midAtTPlus - fill.price) / Math.max(fill.price, 1e-9)) *
        10_000 *
        (fill.side === 'BUY' ? 1 : -1);
      const event: AdverseSelectionEvent = {
        fillId: fill.id,
        signalId: fill.signalId,
        marketId: fill.marketId,
        outcome: fill.outcome,
        side: fill.side,
        fillPrice: fill.price,
        midAtFill,
        midAtTPlus,
        horizonMs: cfg.horizonMs,
        wrongSide,
        signedDriftBps,
        computedAt: Date.now(),
      };
      void cfg.bus.publish(Channels.executorAdverseSelection, event);

      const key = `${fill.marketId}:${fill.outcome}:${fill.signalId ?? 'unknown'}`;
      const current = buckets.get(key) ?? { total: 0, wrongSide: 0 };
      current.total += 1;
      if (wrongSide) current.wrongSide += 1;
      buckets.set(key, current);
      if (current.total >= cfg.minSamples && current.wrongSide / current.total >= cfg.threshold) {
        const breaker: CircuitBreakerEvent = {
          botId: 'executor',
          reason: 'INVENTORY_LIMIT',
          triggeredAt: Date.now(),
          detail: `adverse_selection key=${key} ratio=${(current.wrongSide / current.total).toFixed(2)}`,
        };
        void cfg.bus.publish(Channels.systemCircuitBreaker, breaker);
      }
    }, cfg.horizonMs);
  };

  return {
    ingestFill,
    getBuckets: () => new Map(buckets),
  };
};
