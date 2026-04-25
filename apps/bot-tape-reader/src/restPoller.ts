import {
  bookSnapshotChannel,
  bookSnapshotPattern,
  type OrderBookSnapshot,
  type Outcome,
  type PriceLevel,
} from '@polymarket-bot/contracts';
import type { MessageBus } from '@polymarket-bot/bus';
import type { Logger } from '@polymarket-bot/logger';
import type { TrackedToken } from './discovery';

interface PolymarketBookLevel {
  price: string;
  size: string;
}

interface PolymarketBookResponse {
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
  bids: PolymarketBookLevel[];
  asks: PolymarketBookLevel[];
}

export interface RestPollerOptions {
  httpUrl: string;
  intervalMs: number;
  maxLevels: number;
  tokens: TrackedToken[];
  bus: MessageBus;
  logger: Logger;
}

export interface RestPollerStats {
  pollSequence: number;
  pollSuccesses: number;
  pollErrors: number;
  lastSuccessAt: number | null;
}

const fetchOrderBook = async (
  httpUrl: string,
  tokenId: string,
): Promise<PolymarketBookResponse> => {
  const res = await fetch(`${httpUrl}/book?token_id=${tokenId}`, {
    headers: { 'user-agent': 'polymarket-hft-bot/0.1 (+tape-reader)' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for /book`);
  }
  return (await res.json()) as PolymarketBookResponse;
};

const buildSnapshot = (
  book: PolymarketBookResponse,
  marketId: string,
  outcome: Outcome,
  sequence: number,
  maxLevels: number,
): OrderBookSnapshot => {
  const toLevels = (raw: PolymarketBookLevel[]): PriceLevel[] =>
    raw
      .map(({ price, size }) => ({
        price: Math.min(Math.max(parseFloat(price), 0), 1),
        size: Math.max(parseFloat(size), 0),
      }))
      .filter((lvl) => Number.isFinite(lvl.price) && Number.isFinite(lvl.size));

  const bids = toLevels(book.bids).sort((a, b) => b.price - a.price).slice(0, maxLevels);
  const asks = toLevels(book.asks).sort((a, b) => a.price - b.price).slice(0, maxLevels);

  let midPrice: number | null = null;
  let spread: number | null = null;
  const topBid = bids[0]?.price ?? null;
  const topAsk = asks[0]?.price ?? null;
  if (topBid !== null && topAsk !== null) {
    midPrice = (topBid + topAsk) / 2;
    spread = Math.max(topAsk - topBid, 0);
  }

  return {
    marketId,
    assetId: book.asset_id,
    outcome,
    bids,
    asks,
    midPrice,
    spread,
    timestamp: Date.now(),
    sequence,
  };
};

/**
 * REST-based fallback / cold start poller. Hits `/book` on a fixed interval.
 * Useful when the WebSocket is unavailable or as a smoke test in dev.
 */
export const startRestPoller = (opts: RestPollerOptions) => {
  const stats: RestPollerStats = {
    pollSequence: 0,
    pollSuccesses: 0,
    pollErrors: 0,
    lastSuccessAt: null,
  };
  let timer: ReturnType<typeof setInterval> | null = null;

  const pollOnce = async (): Promise<void> => {
    if (opts.tokens.length === 0) return;
    stats.pollSequence += 1;
    const seq = stats.pollSequence;

    const tasks = opts.tokens.map(async (t) => {
      try {
        const book = await fetchOrderBook(opts.httpUrl, t.tokenId);
        const snapshot = buildSnapshot(book, t.marketId, t.outcome, seq, opts.maxLevels);
        await opts.bus.publishToPattern(
          bookSnapshotPattern,
          bookSnapshotChannel(`${t.marketId}:${t.outcome}`),
          snapshot,
        );
        stats.pollSuccesses += 1;
        stats.lastSuccessAt = Date.now();
      } catch (err) {
        stats.pollErrors += 1;
        opts.logger.warn(
          { err, tokenId: t.tokenId, marketId: t.marketId, outcome: t.outcome },
          'tape-reader.rest.poll.failed',
        );
      }
    });

    await Promise.allSettled(tasks);
  };

  const start = async (): Promise<void> => {
    await pollOnce();
    timer = setInterval(() => {
      pollOnce().catch((err: unknown) =>
        opts.logger.error({ err }, 'tape-reader.rest.loop.unhandled'),
      );
    }, opts.intervalMs);
  };

  const stop = async (): Promise<void> => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { start, stop, getStats: () => ({ ...stats }) };
};
