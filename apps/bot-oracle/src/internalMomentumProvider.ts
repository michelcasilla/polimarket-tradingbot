import { bookSnapshotPattern, type MessageBus } from '@polymarket-bot/bus';
import type { OracleSignal, OrderBookSnapshot } from '@polymarket-bot/contracts';
import type { Logger } from '@polymarket-bot/logger';

export interface InternalMomentumProviderConfig {
  enabled: boolean;
  bus: MessageBus;
  logger: Logger;
  windowMs: number;
  minVelocity: number;
  publishSignal: (signal: OracleSignal) => Promise<void>;
}

interface Tick {
  t: number;
  mid: number;
}

export const createInternalMomentumProvider = (cfg: InternalMomentumProviderConfig) => {
  const ticks = new Map<string, Tick[]>();
  let unsubscribe: (() => Promise<void>) | null = null;
  let snapshotsConsumed = 0;
  let signalsEmitted = 0;

  const ingest = async (snapshot: OrderBookSnapshot): Promise<void> => {
    if (snapshot.midPrice === null) return;
    snapshotsConsumed += 1;
    const key = `${snapshot.marketId}:${snapshot.outcome}`;
    const now = Date.now();
    const arr = ticks.get(key) ?? [];
    arr.push({ t: now, mid: snapshot.midPrice });
    const cutoff = now - cfg.windowMs;
    const trimmed = arr.filter((x) => x.t >= cutoff);
    ticks.set(key, trimmed);
    if (trimmed.length < 2) return;
    const first = trimmed[0]!;
    const last = trimmed[trimmed.length - 1]!;
    const velocity = (last.mid - first.mid) / Math.max((last.t - first.t) / 1000, 0.001);
    if (Math.abs(velocity) < cfg.minVelocity) return;
    const signal: OracleSignal = {
      id: `momentum-${key}-${now}`,
      provider: 'INTERNAL_POLYMARKET',
      eventType: 'PRICE_DELTA',
      impactScore: Math.min(Math.abs(velocity) * 10, 1),
      topic: snapshot.marketId,
      timestamp: now,
      rawData: {
        marketId: snapshot.marketId,
        outcome: snapshot.outcome,
        velocity,
        windowMs: cfg.windowMs,
      },
    };
    signalsEmitted += 1;
    await cfg.publishSignal(signal);
  };

  return {
    start: async (): Promise<void> => {
      if (!cfg.enabled || unsubscribe) return;
      unsubscribe = await cfg.bus.psubscribe(bookSnapshotPattern, (_channel, payload) => {
        void ingest(payload);
      });
    },
    stop: async (): Promise<void> => {
      if (!unsubscribe) return;
      await unsubscribe();
      unsubscribe = null;
    },
    getStats: () => ({
      enabled: cfg.enabled,
      tracked: ticks.size,
      snapshotsConsumed,
      signalsEmitted,
    }),
  };
};
