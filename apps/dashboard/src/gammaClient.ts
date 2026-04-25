import type { MarketMetadataView } from './metadata';

const defaultBase = (): string => {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_GAMMA_API_BASE_URL;
  return (env && env.length > 0 ? env : 'https://gamma-api.polymarket.com').replace(/\/$/, '');
};

const parseNonnegNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
};

export const gammaMarketJsonToView = (raw: Record<string, unknown>, receivedAt: number): MarketMetadataView | null => {
  const marketId = typeof raw.conditionId === 'string' ? raw.conditionId : null;
  if (!marketId) return null;
  const question = typeof raw.question === 'string' ? raw.question : marketId;
  const slug = typeof raw.slug === 'string' ? raw.slug : '';
  let category: string | null = null;
  const events = raw.events;
  if (Array.isArray(events) && events.length > 0) {
    const e0 = events[0];
    if (e0 && typeof e0 === 'object') {
      const t = (e0 as Record<string, unknown>)['ticker'];
      if (typeof t === 'string') category = t;
    }
  }
  const endRaw = raw.endDateIso ?? raw.endDate;
  let endDateIso: string | null = null;
  if (typeof endRaw === 'string') {
    const d = new Date(endRaw);
    endDateIso = Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const active = typeof raw.active === 'boolean' ? raw.active : true;
  const closed = typeof raw.closed === 'boolean' ? raw.closed : false;
  const volume24h =
    parseNonnegNumber(raw.volume24hr) ??
    parseNonnegNumber(raw.volume24hrClob) ??
    parseNonnegNumber(raw.volume1wk);
  const liquidity =
    parseNonnegNumber(raw.liquidityNum) ?? parseNonnegNumber(raw.liquidity) ?? parseNonnegNumber(raw.liquidityClob);

  return {
    marketId,
    question,
    slug,
    category,
    endDateIso,
    active,
    closed,
    volume24h,
    liquidity,
    receivedAt,
  };
};

const normId = (id: string): string => id.trim().toLowerCase();

/**
 * Fetches market rows from Polymarket Gamma by `condition_id` (same as CLOB `marketId`).
 * Batched to stay within practical URL limits. Fills only keys that resolve in the response.
 */
export const fetchGammaMetadataForIds = async (
  requestedIds: string[],
): Promise<Map<string, MarketMetadataView>> => {
  const out = new Map<string, MarketMetadataView>();
  if (requestedIds.length === 0) return out;

  const base = defaultBase();
  const receivedAt = Date.now();
  const CHUNK = 20;

  for (let i = 0; i < requestedIds.length; i += CHUNK) {
    const chunk = requestedIds.slice(i, i + CHUNK);
    const params = new URLSearchParams();
    for (const id of chunk) params.append('condition_ids', id);
    const url = `${base}/markets?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
      });
    } catch {
      continue;
    }
    if (!res.ok) continue;
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    const byNorm = new Map<string, MarketMetadataView>();
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const view = gammaMarketJsonToView(row as Record<string, unknown>, receivedAt);
      if (view) byNorm.set(normId(view.marketId), view);
    }

    for (const requested of chunk) {
      const hit = byNorm.get(normId(requested));
      if (hit) {
        out.set(requested, { ...hit, marketId: requested });
      }
    }
  }

  return out;
};
