import type { MarketMetadata, Outcome } from '@polymarket-bot/contracts';
import type { Logger } from '@polymarket-bot/logger';

export interface TrackedToken {
  marketId: string;
  tokenId: string;
  outcome: Outcome;
  question: string;
  slug: string;
}

export interface DiscoveryResult {
  tokens: TrackedToken[];
  metadata: MarketMetadata[];
}

interface PolymarketSamplingToken {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

interface PolymarketSamplingMarket {
  enable_order_book: boolean;
  active: boolean;
  closed: boolean;
  archived: boolean;
  accepting_orders: boolean;
  condition_id: string;
  question: string;
  market_slug: string;
  category?: string;
  end_date_iso?: string;
  volume_24hr?: number;
  liquidity?: number;
  tokens: PolymarketSamplingToken[];
}

export const normalizeOutcome = (raw: string): Outcome | null => {
  const v = raw.trim().toUpperCase();
  if (v === 'YES') return 'YES';
  if (v === 'NO') return 'NO';
  return null;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'polymarket-hft-bot/0.1 (+tape-reader)' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  return (await res.json()) as T;
};

const toMetadata = (market: PolymarketSamplingMarket): MarketMetadata => {
  const meta: MarketMetadata = {
    marketId: market.condition_id,
    question: market.question,
    slug: market.market_slug,
    active: market.active,
    closed: market.closed,
  };
  if (market.category) meta.category = market.category;
  if (market.end_date_iso) {
    const parsed = new Date(market.end_date_iso);
    if (!Number.isNaN(parsed.getTime())) meta.endDateIso = parsed.toISOString();
  }
  if (typeof market.volume_24hr === 'number' && market.volume_24hr >= 0) {
    meta.volume24h = market.volume_24hr;
  }
  if (typeof market.liquidity === 'number' && market.liquidity >= 0) {
    meta.liquidity = market.liquidity;
  }
  return meta;
};

/**
 * Discover the top N binary YES/NO markets that currently accept orders.
 * Uses Polymarket's `/sampling-markets` endpoint, which is the same source
 * the official Maker Rewards program uses to rank markets.
 *
 * Returns BOTH the per-outcome `TrackedToken[]` (one entry per token, used by
 * the WS/REST clients) AND the per-market `MarketMetadata[]` (one entry per
 * conditionId, used by the dashboard for human-readable labels).
 */
export const discoverMarkets = async (
  httpUrl: string,
  limit: number,
  log: Logger,
): Promise<DiscoveryResult> => {
  const data = await fetchJson<{ data: PolymarketSamplingMarket[] }>(
    `${httpUrl}/sampling-markets`,
  );
  const tokens: TrackedToken[] = [];
  const metadata: MarketMetadata[] = [];
  let marketsAdded = 0;

  for (const market of data.data) {
    if (marketsAdded >= limit) break;
    if (!market.active || market.closed || market.archived) continue;
    if (!market.enable_order_book || !market.accepting_orders) continue;
    if (market.tokens.length !== 2) continue;

    const mapped = market.tokens
      .map((t) => ({ token: t, outcome: normalizeOutcome(t.outcome) }))
      .filter((entry): entry is { token: PolymarketSamplingToken; outcome: Outcome } =>
        entry.outcome !== null,
      );

    if (mapped.length !== 2) continue;

    for (const { token, outcome } of mapped) {
      tokens.push({
        marketId: market.condition_id,
        tokenId: token.token_id,
        outcome,
        question: market.question,
        slug: market.market_slug,
      });
    }
    metadata.push(toMetadata(market));
    marketsAdded += 1;
  }

  log.info(
    { discoveredMarkets: marketsAdded, discoveredTokens: tokens.length },
    'tape-reader.discover.done',
  );
  return { tokens, metadata };
};

export const parseManualTokens = (raw: string): DiscoveryResult => {
  const tokens: TrackedToken[] = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, idx) => {
      const [tokenPart, marketId] = entry.split('@');
      if (!tokenPart || !marketId) {
        throw new Error(
          `TAPE_READER_TOKEN_IDS entry ${idx} malformed: "${entry}". Expected format tokenId:YES@conditionId.`,
        );
      }
      const [tokenId, outcomeRaw] = tokenPart.split(':');
      if (!tokenId || !outcomeRaw) {
        throw new Error(
          `TAPE_READER_TOKEN_IDS entry ${idx} missing outcome: "${entry}". Expected format tokenId:YES@conditionId.`,
        );
      }
      const outcome = normalizeOutcome(outcomeRaw);
      if (!outcome) {
        throw new Error(
          `TAPE_READER_TOKEN_IDS entry ${idx} has invalid outcome: "${outcomeRaw}". Use YES or NO.`,
        );
      }
      return {
        marketId,
        tokenId,
        outcome,
        question: '(manual)',
        slug: tokenId.slice(0, 10),
      } satisfies TrackedToken;
    });

  // Manual mode: synthesise minimal metadata so the dashboard still has a row.
  const seen = new Set<string>();
  const metadata: MarketMetadata[] = [];
  for (const t of tokens) {
    if (seen.has(t.marketId)) continue;
    seen.add(t.marketId);
    metadata.push({
      marketId: t.marketId,
      question: t.question,
      slug: t.slug,
      active: true,
      closed: false,
    });
  }
  return { tokens, metadata };
};
