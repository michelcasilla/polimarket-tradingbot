import type { GatewayEvent } from './types';

export interface MarketMetadataView {
  marketId: string;
  question: string;
  slug: string;
  category: string | null;
  endDateIso: string | null;
  active: boolean;
  closed: boolean;
  volume24h: number | null;
  liquidity: number | null;
  receivedAt: number;
}

const CHANNEL = 'polymarket:markets:metadata';

const isMetadataChannel = (channel: unknown): channel is string =>
  typeof channel === 'string' && channel === CHANNEL;

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asBool = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback;
const asNumber = (value: unknown): number | null => (typeof value === 'number' ? value : null);

export const extractMetadata = (event: GatewayEvent): MarketMetadataView | null => {
  if (!isMetadataChannel(event.payload['channel'])) return null;
  const data = event.payload['data'];
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const marketId = asString(d['marketId']);
  if (!marketId) return null;
  return {
    marketId,
    question: asString(d['question']) ?? marketId,
    slug: asString(d['slug']) ?? '',
    category: asString(d['category']),
    endDateIso: asString(d['endDateIso']),
    active: asBool(d['active'], true),
    closed: asBool(d['closed'], false),
    volume24h: asNumber(d['volume24h']),
    liquidity: asNumber(d['liquidity']),
    receivedAt: event.timestamp,
  };
};

/**
 * Build a `marketId -> MarketMetadataView` map from the rare-events buffer.
 * Newest event wins (events arrive newest-first; we set if absent).
 */
export const buildMetadataMap = (events: GatewayEvent[]): Map<string, MarketMetadataView> => {
  const map = new Map<string, MarketMetadataView>();
  for (const event of events) {
    const meta = extractMetadata(event);
    if (!meta) continue;
    if (!map.has(meta.marketId)) {
      map.set(meta.marketId, meta);
    }
  }
  return map;
};
