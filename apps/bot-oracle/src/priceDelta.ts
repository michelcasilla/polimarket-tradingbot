import type { OracleSignal } from '@polymarket-bot/contracts';
import type { TickerUpdate } from './binanceClient';

/**
 * Sliding-window price-delta detector.
 *
 * For each symbol it maintains a deque of (timestamp, price) samples bounded
 * by `windowMs`. On every tick it computes the percentage delta between the
 * oldest in-window sample and the newest, and emits an `OracleSignal` when:
 *   |delta%| >= minDeltaPct
 *   AND time since last emission >= cooldownMs
 *
 * Impact score is normalized to [0,1] using `saturationDeltaPct` (any move
 * >= saturation yields impactScore = 1).
 */

export interface PriceDeltaConfig {
  windowMs: number;
  minDeltaPct: number;
  saturationDeltaPct: number;
  cooldownMs: number;
  symbolToTopic: (symbol: string) => string;
}

interface Sample {
  t: number;
  price: number;
}

interface SymbolState {
  samples: Sample[];
  lastEmittedAt: number;
  lastEmittedDeltaPct: number;
  lastPrice: number | null;
}

export interface PriceDeltaDetector {
  ingest: (update: TickerUpdate) => OracleSignal | null;
  getState: () => Record<string, {
    samples: number;
    lastPrice: number | null;
    lastEmittedAt: number;
    lastEmittedDeltaPct: number;
  }>;
}

export const createPriceDeltaDetector = (cfg: PriceDeltaConfig): PriceDeltaDetector => {
  const states = new Map<string, SymbolState>();

  const ensure = (symbol: string): SymbolState => {
    let st = states.get(symbol);
    if (!st) {
      st = { samples: [], lastEmittedAt: 0, lastEmittedDeltaPct: 0, lastPrice: null };
      states.set(symbol, st);
    }
    return st;
  };

  const trim = (samples: Sample[], cutoff: number): Sample[] => {
    let i = 0;
    while (i < samples.length && samples[i]!.t < cutoff) i += 1;
    return i === 0 ? samples : samples.slice(i);
  };

  return {
    ingest(update) {
      const st = ensure(update.symbol);
      const now = update.eventTime || Date.now();
      st.lastPrice = update.lastPrice;
      st.samples.push({ t: now, price: update.lastPrice });
      st.samples = trim(st.samples, now - cfg.windowMs);
      if (st.samples.length < 2) return null;

      const oldest = st.samples[0]!;
      const newest = st.samples[st.samples.length - 1]!;
      if (oldest.price <= 0) return null;
      const deltaPct = ((newest.price - oldest.price) / oldest.price) * 100;

      if (Math.abs(deltaPct) < cfg.minDeltaPct) return null;
      if (now - st.lastEmittedAt < cfg.cooldownMs) return null;

      const direction = deltaPct >= 0 ? 'UP' : 'DOWN';
      const magnitude = Math.min(
        Math.abs(deltaPct) / Math.max(cfg.saturationDeltaPct, 0.0001),
        1,
      );
      const impactScore = Math.max(0, Math.min(1, magnitude));

      st.lastEmittedAt = now;
      st.lastEmittedDeltaPct = deltaPct;

      const topic = cfg.symbolToTopic(update.symbol);
      const signal: OracleSignal = {
        id: `binance-${update.symbol.toLowerCase()}-${now}`,
        provider: 'BINANCE',
        eventType: 'PRICE_DELTA',
        impactScore,
        topic,
        timestamp: now,
        rawData: {
          symbol: update.symbol,
          windowMs: cfg.windowMs,
          windowStartPrice: oldest.price,
          windowEndPrice: newest.price,
          deltaPct,
          direction,
          priceChangePct24h: update.priceChangePct24h,
          volume24h: update.volume24h,
          samples: st.samples.length,
        },
      };
      return signal;
    },
    getState() {
      const out: Record<string, {
        samples: number;
        lastPrice: number | null;
        lastEmittedAt: number;
        lastEmittedDeltaPct: number;
      }> = {};
      for (const [sym, st] of states) {
        out[sym] = {
          samples: st.samples.length,
          lastPrice: st.lastPrice,
          lastEmittedAt: st.lastEmittedAt,
          lastEmittedDeltaPct: st.lastEmittedDeltaPct,
        };
      }
      return out;
    },
  };
};

/**
 * Default mapping from Binance trading pair to a normalized topic
 * (e.g. "BTCUSDT" -> "BTC-USDT"). Tries common quote suffixes; falls back to
 * the upper-cased raw symbol.
 */
export const defaultSymbolToTopic = (symbol: string): string => {
  const upper = symbol.toUpperCase();
  const quotes = ['USDT', 'USDC', 'BUSD', 'TUSD', 'FDUSD', 'DAI', 'BTC', 'ETH', 'BNB'];
  for (const q of quotes) {
    if (upper.endsWith(q) && upper.length > q.length) {
      return `${upper.slice(0, -q.length)}-${q}`;
    }
  }
  return upper;
};
