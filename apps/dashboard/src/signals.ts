import type { GatewayEvent } from './types';
import type { MarketSnapshot } from './market';

export type SignalReason =
  | 'SPREAD_CAPTURE'
  | 'SUM_TO_ONE_ARBITRAGE'
  | 'NEWS_ARBITRAGE'
  | 'OPTIMISTIC_BIAS'
  | 'INVENTORY_REBALANCE'
  | 'MANUAL';

export type SignalDirection = 'SELL_BOTH' | 'BUY_BOTH' | string;

export interface StrategistSignal {
  marketId: string;
  outcome: 'YES' | 'NO';
  fairPrice: number;
  confidence: number;
  reason: SignalReason;
  ttlMs: number;
  timestamp: number;
  direction: SignalDirection | null;
  edge: number | null;
  spread: number | null;
  midPrice: number | null;
  raw: Record<string, unknown>;
}

const isStrategistChannel = (channel: unknown): channel is string =>
  channel === 'strategist:signals';

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const extractSignal = (event: GatewayEvent): StrategistSignal | null => {
  if (!isStrategistChannel(event.payload['channel'])) return null;
  const data = event.payload['data'];
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const marketId = stringOrNull(d['marketId']);
  const outcomeRaw = stringOrNull(d['outcome']);
  const reasonRaw = stringOrNull(d['reason']);
  const outcome = outcomeRaw === 'YES' || outcomeRaw === 'NO' ? outcomeRaw : null;
  const fairPrice = numberOrNull(d['fairPrice']);
  const confidence = numberOrNull(d['confidence']);
  const ttlMs = numberOrNull(d['ttlMs']);
  const timestamp = numberOrNull(d['timestamp']) ?? event.timestamp;
  if (!marketId || !outcome || !reasonRaw || fairPrice === null || confidence === null) {
    return null;
  }
  const metadata = (d['metadata'] ?? {}) as Record<string, unknown>;
  return {
    marketId,
    outcome,
    fairPrice,
    confidence,
    reason: reasonRaw as SignalReason,
    ttlMs: ttlMs ?? 5000,
    timestamp,
    direction: stringOrNull(metadata['direction']) ?? null,
    edge: numberOrNull(metadata['edge']),
    spread: numberOrNull(metadata['spread']),
    midPrice: numberOrNull(metadata['midPrice']),
    raw: d,
  };
};

export const buildSignalMap = (events: GatewayEvent[]): StrategistSignal[] => {
  const latest = new Map<string, StrategistSignal>();
  // events newest-first; only keep first encountered per key.
  for (const event of events) {
    const sig = extractSignal(event);
    if (!sig) continue;
    const key = `${sig.marketId}:${sig.outcome}:${sig.reason}:${sig.direction ?? ''}`;
    if (!latest.has(key)) latest.set(key, sig);
  }
  return Array.from(latest.values()).sort((a, b) => b.timestamp - a.timestamp);
};

/** Returns true when the signal's TTL has expired relative to "now". */
export const isStale = (signal: StrategistSignal, now: number): boolean =>
  now - signal.timestamp > signal.ttlMs;

/**
 * Marries a signal with the current snapshot of the same outcome to compute
 * the live "edge" in basis points (fair vs current top-of-book, signed).
 */
export const liveEdgeBps = (
  signal: StrategistSignal,
  snapshots: MarketSnapshot[],
): number | null => {
  const snap = snapshots.find(
    (s) => s.marketId === signal.marketId && s.outcome === signal.outcome,
  );
  if (!snap) return null;
  // SELL_BOTH means the book bids high, compare against bestBid.
  // BUY_BOTH means the book asks low, compare against bestAsk.
  const reference =
    signal.direction === 'SELL_BOTH' ? snap.bestBid :
    signal.direction === 'BUY_BOTH' ? snap.bestAsk :
    snap.midPrice;
  if (reference === null) return null;
  return (reference - signal.fairPrice) * 10_000;
};
