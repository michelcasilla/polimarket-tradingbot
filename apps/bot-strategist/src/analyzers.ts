import type {
  MarketSignal,
  OracleSignal,
  OrderBookSnapshot,
  Position,
} from '@polymarket-bot/contracts';

export interface AnalyzerThresholds {
  /** Minimum edge in probability (e.g. 0.01 = 1¢) to fire a sum-to-one signal. */
  sumToOneEdge: number;
  /** Minimum spread (e.g. 0.04 = 4¢) to fire a SPREAD_CAPTURE signal. */
  spreadCaptureMin: number;
  /** Signal time-to-live in milliseconds. */
  signalTtlMs: number;
}

export type NewsCorrelation = 'POS' | 'NEG';

export interface NewsTopicMapping {
  /** Oracle signal topic, e.g. "BTC-USDT". */
  topic: string;
  /** Polymarket marketId (conditionId or `${conditionId}:${outcome}`). */
  marketId: string;
  /** POS: oracle delta up -> favor YES. NEG: oracle delta up -> favor NO. */
  correlation: NewsCorrelation;
}

export interface NewsAnalyzerConfig {
  minImpact: number;
  ttlMs: number;
  /** How much to nudge `fairPrice` away from the current best, per unit impact. */
  fairPriceNudge: number;
  mappings: NewsTopicMapping[];
}

export interface MarketBookPair {
  marketId: string;
  yes?: OrderBookSnapshot;
  no?: OrderBookSnapshot;
}

const clampProb = (n: number): number => Math.min(Math.max(n, 0), 1);

const isFinitePositive = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

const topBid = (snap: OrderBookSnapshot): number | null => snap.bids[0]?.price ?? null;
const topAsk = (snap: OrderBookSnapshot): number | null => snap.asks[0]?.price ?? null;

/**
 * Sum-to-One arbitrage:
 *   P(YES) + P(NO) must equal 1.
 *   - If bestBid(YES) + bestBid(NO) > 1 + edge:
 *       The book offers to PAY more than $1 for the {YES, NO} pair. Sell both
 *       sides at the top of book to lock in a guaranteed positive return.
 *   - If bestAsk(YES) + bestAsk(NO) < 1 - edge:
 *       The book offers to SELL the pair for less than $1. Buy both to lock in
 *       a guaranteed positive return.
 *
 * The "fair price" we emit per outcome is derived from the *opposite* leg of
 * the arb so the executor can size against it without re-deriving the math.
 */
export const detectSumToOneArb = (
  pair: MarketBookPair,
  thresholds: AnalyzerThresholds,
  now: number,
): MarketSignal[] => {
  if (!pair.yes || !pair.no) return [];

  const ybBid = topBid(pair.yes);
  const ybAsk = topAsk(pair.yes);
  const nbBid = topBid(pair.no);
  const nbAsk = topAsk(pair.no);

  const out: MarketSignal[] = [];

  if (isFinitePositive(ybBid) && isFinitePositive(nbBid)) {
    const sumBid = ybBid + nbBid;
    const edge = sumBid - 1;
    if (edge > thresholds.sumToOneEdge) {
      const confidence = clampProb(edge / 0.05);
      out.push({
        marketId: pair.marketId,
        outcome: 'YES',
        fairPrice: clampProb(1 - nbBid),
        confidence,
        reason: 'SUM_TO_ONE_ARBITRAGE',
        ttlMs: thresholds.signalTtlMs,
        timestamp: now,
        metadata: {
          direction: 'SELL_BOTH',
          edge,
          sumBid,
          bestBidYes: ybBid,
          bestBidNo: nbBid,
        },
      });
      out.push({
        marketId: pair.marketId,
        outcome: 'NO',
        fairPrice: clampProb(1 - ybBid),
        confidence,
        reason: 'SUM_TO_ONE_ARBITRAGE',
        ttlMs: thresholds.signalTtlMs,
        timestamp: now,
        metadata: {
          direction: 'SELL_BOTH',
          edge,
          sumBid,
          bestBidYes: ybBid,
          bestBidNo: nbBid,
        },
      });
    }
  }

  if (isFinitePositive(ybAsk) && isFinitePositive(nbAsk)) {
    const sumAsk = ybAsk + nbAsk;
    const edge = 1 - sumAsk;
    if (edge > thresholds.sumToOneEdge) {
      const confidence = clampProb(edge / 0.05);
      out.push({
        marketId: pair.marketId,
        outcome: 'YES',
        fairPrice: clampProb(1 - nbAsk),
        confidence,
        reason: 'SUM_TO_ONE_ARBITRAGE',
        ttlMs: thresholds.signalTtlMs,
        timestamp: now,
        metadata: {
          direction: 'BUY_BOTH',
          edge,
          sumAsk,
          bestAskYes: ybAsk,
          bestAskNo: nbAsk,
        },
      });
      out.push({
        marketId: pair.marketId,
        outcome: 'NO',
        fairPrice: clampProb(1 - ybAsk),
        confidence,
        reason: 'SUM_TO_ONE_ARBITRAGE',
        ttlMs: thresholds.signalTtlMs,
        timestamp: now,
        metadata: {
          direction: 'BUY_BOTH',
          edge,
          sumAsk,
          bestAskYes: ybAsk,
          bestAskNo: nbAsk,
        },
      });
    }
  }

  return out;
};

/**
 * Market-Making (spread capture):
 *   When the spread is wide enough, post a Maker quote at midPrice (the
 *   executor will translate that into a Post-Only LIMIT on the appropriate
 *   side once it knows current inventory).
 */
export const detectSpreadCapture = (
  snap: OrderBookSnapshot,
  thresholds: AnalyzerThresholds,
  now: number,
  position?: Position | null,
  inventorySkewBps: number = 0,
  maxInventoryShares: number = 1,
): MarketSignal | null => {
  if (snap.spread === null || snap.midPrice === null) return null;
  if (snap.spread < thresholds.spreadCaptureMin) return null;

  const ratioBase = maxInventoryShares <= 0 ? 0 : (position?.netSize ?? 0) / maxInventoryShares;
  const inventoryRatio = Math.max(-1, Math.min(1, ratioBase));
  if (Math.abs(ratioBase) > 1) return null;
  const skew = (inventorySkewBps / 10_000) * inventoryRatio;
  const skewedFair = clampProb(snap.midPrice - skew);
  const confidence = clampProb(snap.spread / 0.1);
  return {
    marketId: snap.marketId,
    outcome: snap.outcome,
    fairPrice: skewedFair,
    confidence,
    reason: 'SPREAD_CAPTURE',
    ttlMs: thresholds.signalTtlMs,
    timestamp: now,
    metadata: {
      spread: snap.spread,
      midPrice: snap.midPrice,
      inventorySkewBps,
      inventoryRatio,
      bidDepth: snap.bids.reduce((sum, lvl) => sum + lvl.size, 0),
      askDepth: snap.asks.reduce((sum, lvl) => sum + lvl.size, 0),
    },
  };
};

/**
 * News Arbitrage:
 *   When `bot-oracle` publishes a strong external move (e.g. BTC +1% in the
 *   last 60s on Binance), look up the configured Polymarket markets that are
 *   correlated with that topic and emit `NEWS_ARBITRAGE` `MarketSignal`s
 *   nudging the fair price in the direction of the move.
 *
 *   Without `pair` snapshots we still emit so the dashboard surfaces the
 *   signal; the executor (Plan 4) will guard with snapshot freshness.
 */
export const detectNewsArbitrage = (
  oracle: OracleSignal,
  cfg: NewsAnalyzerConfig,
  pairs: Map<string, MarketBookPair>,
  now: number,
): MarketSignal[] => {
  if (oracle.impactScore < cfg.minImpact) return [];
  const out: MarketSignal[] = [];

  const raw = (oracle.rawData ?? {}) as Record<string, unknown>;
  const deltaPct = typeof raw['deltaPct'] === 'number' ? (raw['deltaPct'] as number) : 0;
  const moveUp = deltaPct >= 0;

  for (const mapping of cfg.mappings) {
    if (mapping.topic !== oracle.topic) continue;
    const favorYes = mapping.correlation === 'POS' ? moveUp : !moveUp;
    const outcome: 'YES' | 'NO' = favorYes ? 'YES' : 'NO';

    const pair = pairs.get(mapping.marketId);
    const snap = outcome === 'YES' ? pair?.yes : pair?.no;
    const reference = snap?.midPrice ?? 0.5;
    const nudge = cfg.fairPriceNudge * oracle.impactScore;
    const fairPrice = clampProb(reference + nudge);

    out.push({
      marketId: mapping.marketId,
      outcome,
      fairPrice,
      confidence: clampProb(oracle.impactScore),
      reason: 'NEWS_ARBITRAGE',
      ttlMs: cfg.ttlMs,
      timestamp: now,
      metadata: {
        direction: favorYes ? 'BUY_YES' : 'BUY_NO',
        topic: oracle.topic,
        provider: oracle.provider,
        eventType: oracle.eventType,
        impactScore: oracle.impactScore,
        deltaPct,
        reference,
        nudge,
        correlation: mapping.correlation,
      },
    });
  }

  return out;
};

/** Parse `STRATEGIST_NEWS_TOPIC_MARKETS` env var. Format:
 *  "TOPIC:marketId:CORR,TOPIC:marketId:CORR" where CORR is POS or NEG.
 *  Whitespace and trailing commas are ignored. Invalid items are skipped.
 */
export const parseNewsMappings = (raw: string | undefined): NewsTopicMapping[] => {
  if (!raw) return [];
  const out: NewsTopicMapping[] = [];
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    if (parts.length < 3) continue;
    const topic = parts[0]!.trim();
    const marketId = parts[1]!.trim();
    const correlation = parts[2]!.trim().toUpperCase();
    if (!topic || !marketId) continue;
    if (correlation !== 'POS' && correlation !== 'NEG') continue;
    out.push({ topic, marketId, correlation });
  }
  return out;
};

/**
 * Build a stable identity key for a signal so we can de-duplicate emissions
 * (don't spam the bus with identical signals every snapshot).
 */
export const signalKey = (signal: MarketSignal): string => {
  const direction = signal.metadata?.['direction'] ?? '';
  return `${signal.marketId}:${signal.outcome}:${signal.reason}:${direction}`;
};

/**
 * Two signals are "near-equal" if their fair price moved by less than 1/10 of
 * the configured spread threshold. We use that to skip republishing the same
 * idea over and over while the book oscillates within noise.
 */
export const isMaterialUpdate = (
  prev: MarketSignal | undefined,
  next: MarketSignal,
  priceEpsilon: number,
): boolean => {
  if (!prev) return true;
  if (Math.abs(prev.fairPrice - next.fairPrice) >= priceEpsilon) return true;
  if (Math.abs(prev.confidence - next.confidence) >= 0.05) return true;
  return false;
};
