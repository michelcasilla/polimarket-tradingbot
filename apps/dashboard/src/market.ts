import type { GatewayEvent } from './types';

export interface PriceLevel {
  price: number;
  size: number;
}

export interface MarketSnapshot {
  marketId: string;
  outcome: 'YES' | 'NO';
  assetId: string;
  midPrice: number | null;
  spread: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  bidDepth: number;
  askDepth: number;
  bids: PriceLevel[];
  asks: PriceLevel[];
  sequence: number;
  timestamp: number;
}

const isSnapshotChannel = (channel: unknown): channel is string =>
  typeof channel === 'string' && channel.startsWith('polymarket:book:snapshot:');

const isPriceLevel = (value: unknown): value is PriceLevel => {
  if (!value || typeof value !== 'object') return false;
  const v = value as { price?: unknown; size?: unknown };
  return typeof v.price === 'number' && typeof v.size === 'number';
};

const toLevels = (value: unknown): PriceLevel[] =>
  Array.isArray(value) ? value.filter(isPriceLevel) : [];

const totalSize = (levels: PriceLevel[]): number =>
  levels.reduce((sum, lvl) => sum + lvl.size, 0);

export const extractSnapshot = (event: GatewayEvent): MarketSnapshot | null => {
  if (!isSnapshotChannel(event.payload['channel'])) return null;
  const data = event.payload['data'];
  if (!data || typeof data !== 'object') return null;

  const d = data as Record<string, unknown>;
  const marketId = typeof d['marketId'] === 'string' ? d['marketId'] : null;
  const outcomeRaw = typeof d['outcome'] === 'string' ? d['outcome'].toUpperCase() : null;
  const outcome = outcomeRaw === 'YES' || outcomeRaw === 'NO' ? outcomeRaw : null;
  if (!marketId || !outcome) return null;

  const bids = toLevels(d['bids']);
  const asks = toLevels(d['asks']);

  return {
    marketId,
    outcome,
    assetId: typeof d['assetId'] === 'string' ? d['assetId'] : '',
    midPrice: typeof d['midPrice'] === 'number' ? d['midPrice'] : null,
    spread: typeof d['spread'] === 'number' ? d['spread'] : null,
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    bidDepth: totalSize(bids),
    askDepth: totalSize(asks),
    bids,
    asks,
    sequence: typeof d['sequence'] === 'number' ? d['sequence'] : 0,
    timestamp: typeof d['timestamp'] === 'number' ? d['timestamp'] : event.timestamp,
  };
};

export const buildSnapshotMap = (events: GatewayEvent[]): MarketSnapshot[] => {
  const latest = new Map<string, MarketSnapshot>();
  // events arrive newest-first; preserve newest by skipping if key already set.
  for (const event of events) {
    const snap = extractSnapshot(event);
    if (!snap) continue;
    const key = `${snap.marketId}:${snap.outcome}`;
    if (!latest.has(key)) latest.set(key, snap);
  }
  return Array.from(latest.values()).sort((a, b) => b.timestamp - a.timestamp);
};

export const formatProb = (value: number | null): string =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`;

export const formatSpread = (value: number | null): string =>
  value === null ? '—' : `${(value * 100).toFixed(2)} pp`;

export const formatSize = (value: number): string => {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(0);
};

export const truncateId = (value: string, head = 6, tail = 4): string =>
  value.length > head + tail + 3 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
