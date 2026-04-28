import { createRedis } from '@polymarket-bot/bus';
import type { Fill, Position } from '@polymarket-bot/contracts';

export interface PositionBookConfig {
  redisUrl: string;
}

const keyOf = (marketId: string, outcome: string): string => `${marketId}:${outcome}`;
const redisKey = (marketId: string, outcome: string): string =>
  `polymarket:positions:${marketId}:${outcome}`;

export const createPositionBook = (cfg: PositionBookConfig) => {
  const redis = createRedis({ url: cfg.redisUrl, connectionName: 'bot-executor-position-book' });
  const positions = new Map<string, Position>();

  const applyMark = (marketId: string, outcome: 'YES' | 'NO', midPrice: number): Position | null => {
    const key = keyOf(marketId, outcome);
    const prev = positions.get(key);
    if (!prev) return null;
    const unrealized = (midPrice - prev.averageEntryPrice) * prev.netSize;
    const next: Position = {
      ...prev,
      unrealizedPnlUsdc: unrealized,
      updatedAt: Date.now(),
    };
    positions.set(key, next);
    return next;
  };

  const upsert = async (position: Position): Promise<void> => {
    const key = keyOf(position.marketId, position.outcome);
    positions.set(key, position);
    try {
      if (redis.status === 'wait') await redis.connect();
      await redis.set(redisKey(position.marketId, position.outcome), JSON.stringify(position));
    } catch {
      // Keep an in-memory fallback when Redis is temporarily unavailable.
    }
  };

  const applyFill = async (fill: Fill): Promise<Position> => {
    const key = keyOf(fill.marketId, fill.outcome);
    const prev =
      positions.get(key) ??
      ({
        marketId: fill.marketId,
        outcome: fill.outcome,
        netSize: 0,
        averageEntryPrice: fill.price,
        realizedPnlUsdc: 0,
        unrealizedPnlUsdc: 0,
        lastFillAt: null,
        source: 'LOCAL',
        updatedAt: Date.now(),
      } satisfies Position);
    const signedSize = fill.side === 'BUY' ? fill.size : -fill.size;
    const newNet = prev.netSize + signedSize;
    const avgEntry =
      prev.netSize === 0 || Math.sign(prev.netSize) === Math.sign(signedSize)
        ? (prev.averageEntryPrice * Math.abs(prev.netSize) + fill.price * Math.abs(signedSize)) /
          Math.max(Math.abs(newNet), 1e-9)
        : prev.averageEntryPrice;
    const realized = prev.realizedPnlUsdc - fill.feesUsdc;
    const next: Position = {
      marketId: fill.marketId,
      outcome: fill.outcome,
      netSize: newNet,
      averageEntryPrice: Math.min(Math.max(avgEntry, 0), 1),
      realizedPnlUsdc: realized,
      unrealizedPnlUsdc: prev.unrealizedPnlUsdc,
      lastFillAt: fill.timestamp,
      source: 'LOCAL',
      updatedAt: Date.now(),
    };
    await upsert(next);
    return next;
  };

  return {
    applyFill,
    applyMark,
    upsert,
    getPosition: (marketId: string, outcome: 'YES' | 'NO'): Position | null =>
      positions.get(keyOf(marketId, outcome)) ?? null,
    snapshot: (): Position[] => Array.from(positions.values()),
    shutdown: async (): Promise<void> => {
      if (redis.status !== 'end') await redis.quit().catch(() => undefined);
    },
  };
};

export type PositionBook = ReturnType<typeof createPositionBook>;
