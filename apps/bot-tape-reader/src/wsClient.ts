import {
  bookDeltaChannel,
  bookDeltaPattern,
  bookSnapshotChannel,
  bookSnapshotPattern,
  type OrderBookDelta,
  type OrderBookSnapshot,
  type PriceLevel,
} from '@polymarket-bot/contracts';
import type { MessageBus } from '@polymarket-bot/bus';
import type { Logger } from '@polymarket-bot/logger';
import type { TrackedToken } from './discovery';

/**
 * Polymarket CLOB Market Channel WebSocket client.
 *
 * Endpoint: wss://ws-subscriptions-clob.polymarket.com/ws/market
 *
 * Behaviours:
 *  - Subscribes to all tracked token IDs in a single connection.
 *  - Maintains an in-memory L2 order book per token.
 *  - On `book` event: replaces the local book and publishes a snapshot.
 *  - On `price_change` event: applies each delta (size=0 removes the level),
 *    publishes both a delta and an updated snapshot so downstream consumers
 *    can stay snapshot-only if they want.
 *  - Heartbeat: send "PING" every 10s (CLOB replies with "PONG").
 *  - Auto-reconnect with exponential backoff (max 30s).
 */

interface BookState {
  bids: Map<number, number>; // price -> size
  asks: Map<number, number>;
  sequence: number;
}

interface BookEvent {
  event_type: 'book';
  asset_id: string;
  market: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  timestamp: string;
  hash?: string;
}

interface PriceChange {
  asset_id: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  hash?: string;
  best_bid?: string;
  best_ask?: string;
}

interface PriceChangeEvent {
  event_type: 'price_change';
  market: string;
  price_changes: PriceChange[];
  timestamp: string;
}

interface OtherEvent {
  event_type: string;
  [k: string]: unknown;
}

type ClobEvent = BookEvent | PriceChangeEvent | OtherEvent;

const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

export interface ClobWsClientOptions {
  wsUrl: string;
  tokens: TrackedToken[];
  maxLevels: number;
  bus: MessageBus;
  logger: Logger;
  customFeatureEnabled?: boolean;
}

export interface ClobWsStats {
  connections: number;
  reconnects: number;
  bookEvents: number;
  priceChangeEvents: number;
  otherEvents: number;
  parseErrors: number;
  publishErrors: number;
  lastEventAt: number | null;
  state: 'idle' | 'connecting' | 'open' | 'closed';
}

const parsePrice = (raw: string): number => {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0;
};

const parseSize = (raw: string): number => {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const mapToLevels = (map: Map<number, number>, maxLevels: number, dir: 'desc' | 'asc'): PriceLevel[] => {
  const levels: PriceLevel[] = [];
  for (const [price, size] of map) {
    if (size <= 0) continue;
    levels.push({ price, size });
  }
  levels.sort((a, b) => (dir === 'desc' ? b.price - a.price : a.price - b.price));
  return levels.slice(0, maxLevels);
};

const buildSnapshotFromState = (
  state: BookState,
  token: TrackedToken,
  maxLevels: number,
): OrderBookSnapshot => {
  const bids = mapToLevels(state.bids, maxLevels, 'desc');
  const asks = mapToLevels(state.asks, maxLevels, 'asc');
  const topBid = bids[0]?.price ?? null;
  const topAsk = asks[0]?.price ?? null;
  const midPrice = topBid !== null && topAsk !== null ? (topBid + topAsk) / 2 : null;
  const spread = topBid !== null && topAsk !== null ? Math.max(topAsk - topBid, 0) : null;
  return {
    marketId: token.marketId,
    assetId: token.tokenId,
    outcome: token.outcome,
    bids,
    asks,
    midPrice,
    spread,
    timestamp: Date.now(),
    sequence: state.sequence,
  };
};

export const startClobWsClient = (opts: ClobWsClientOptions) => {
  const stats: ClobWsStats = {
    connections: 0,
    reconnects: 0,
    bookEvents: 0,
    priceChangeEvents: 0,
    otherEvents: 0,
    parseErrors: 0,
    publishErrors: 0,
    lastEventAt: null,
    state: 'idle',
  };

  const tokensByAssetId = new Map<string, TrackedToken>();
  for (const t of opts.tokens) tokensByAssetId.set(t.tokenId, t);

  const books = new Map<string, BookState>();
  const ensureBook = (assetId: string): BookState => {
    let state = books.get(assetId);
    if (!state) {
      state = { bids: new Map(), asks: new Map(), sequence: 0 };
      books.set(assetId, state);
    }
    return state;
  };

  let ws: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  let stopped = false;

  const publishSnapshot = async (token: TrackedToken, state: BookState): Promise<void> => {
    try {
      const snapshot = buildSnapshotFromState(state, token, opts.maxLevels);
      await opts.bus.publishToPattern(
        bookSnapshotPattern,
        bookSnapshotChannel(`${token.marketId}:${token.outcome}`),
        snapshot,
      );
    } catch (err) {
      stats.publishErrors += 1;
      opts.logger.warn({ err, assetId: token.tokenId }, 'tape-reader.ws.publish.snapshot.failed');
    }
  };

  const publishDelta = async (delta: OrderBookDelta): Promise<void> => {
    try {
      await opts.bus.publishToPattern(
        bookDeltaPattern,
        bookDeltaChannel(`${delta.marketId}:${delta.outcome}`),
        delta,
      );
    } catch (err) {
      stats.publishErrors += 1;
      opts.logger.warn({ err, marketId: delta.marketId }, 'tape-reader.ws.publish.delta.failed');
    }
  };

  const handleBookEvent = async (event: BookEvent): Promise<void> => {
    stats.bookEvents += 1;
    stats.lastEventAt = Date.now();
    const token = tokensByAssetId.get(event.asset_id);
    if (!token) return;

    const state = ensureBook(event.asset_id);
    state.bids.clear();
    state.asks.clear();
    for (const lvl of event.bids) {
      const size = parseSize(lvl.size);
      if (size > 0) state.bids.set(parsePrice(lvl.price), size);
    }
    for (const lvl of event.asks) {
      const size = parseSize(lvl.size);
      if (size > 0) state.asks.set(parsePrice(lvl.price), size);
    }
    state.sequence += 1;
    await publishSnapshot(token, state);
  };

  const handlePriceChangeEvent = async (event: PriceChangeEvent): Promise<void> => {
    stats.priceChangeEvents += 1;
    stats.lastEventAt = Date.now();
    const updated = new Map<string, true>();

    for (const change of event.price_changes) {
      const token = tokensByAssetId.get(change.asset_id);
      if (!token) continue;
      const state = ensureBook(change.asset_id);
      const price = parsePrice(change.price);
      const size = parseFloat(change.size); // 0 means "removed"
      const sideKey = change.side === 'BUY' ? 'bids' : 'asks';
      if (!Number.isFinite(size) || size <= 0) {
        state[sideKey].delete(price);
      } else {
        state[sideKey].set(price, size);
      }
      state.sequence += 1;

      const delta: OrderBookDelta = {
        marketId: token.marketId,
        assetId: token.tokenId,
        outcome: token.outcome,
        changes: [
          {
            side: change.side === 'BUY' ? 'bid' : 'ask',
            price,
            size: Math.max(size, 0),
          },
        ],
        timestamp: Date.now(),
        sequence: state.sequence,
      };
      await publishDelta(delta);
      updated.set(change.asset_id, true);
    }

    for (const assetId of updated.keys()) {
      const token = tokensByAssetId.get(assetId);
      const state = books.get(assetId);
      if (token && state) await publishSnapshot(token, state);
    }
  };

  const routeMessage = async (raw: string): Promise<void> => {
    if (raw === 'PONG' || raw === 'pong') return;

    let parsed: ClobEvent | ClobEvent[];
    try {
      parsed = JSON.parse(raw) as ClobEvent | ClobEvent[];
    } catch (err) {
      stats.parseErrors += 1;
      opts.logger.warn({ err, sample: raw.slice(0, 200) }, 'tape-reader.ws.parse.failed');
      return;
    }

    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const event of events) {
      if (!event || typeof event !== 'object' || !('event_type' in event)) continue;
      switch (event.event_type) {
        case 'book':
          await handleBookEvent(event as BookEvent);
          break;
        case 'price_change':
          await handlePriceChangeEvent(event as PriceChangeEvent);
          break;
        default:
          stats.otherEvents += 1;
          opts.logger.debug({ type: event.event_type }, 'tape-reader.ws.event.other');
      }
    }
  };

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    opts.logger.info({ wait }, 'tape-reader.ws.reconnect.scheduled');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  };

  const subscribeAll = (): void => {
    if (!ws) return;
    const assetIds = opts.tokens.map((t) => t.tokenId);
    if (assetIds.length === 0) {
      opts.logger.warn('tape-reader.ws.subscribe.no_tokens');
      return;
    }
    const sub = {
      type: 'market',
      assets_ids: assetIds,
      custom_feature_enabled: opts.customFeatureEnabled ?? false,
    };
    ws.send(JSON.stringify(sub));
    opts.logger.info({ count: assetIds.length }, 'tape-reader.ws.subscribed');
  };

  const connect = (): void => {
    if (stopped) return;
    stats.state = 'connecting';
    opts.logger.info({ url: opts.wsUrl }, 'tape-reader.ws.connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(opts.wsUrl);
    } catch (err) {
      opts.logger.error({ err }, 'tape-reader.ws.construct.failed');
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      stats.state = 'open';
      stats.connections += 1;
      backoff = INITIAL_BACKOFF_MS;
      opts.logger.info('tape-reader.ws.open');
      subscribeAll();
      stopHeartbeat();
      heartbeat = setInterval(() => {
        try {
          socket.send('PING');
        } catch (err) {
          opts.logger.warn({ err }, 'tape-reader.ws.ping.failed');
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    socket.onmessage = (msg: MessageEvent) => {
      const data = typeof msg.data === 'string' ? msg.data : msg.data?.toString?.() ?? '';
      void routeMessage(String(data));
    };

    socket.onerror = (event) => {
      opts.logger.warn({ event: String(event) }, 'tape-reader.ws.error');
    };

    socket.onclose = (event) => {
      stats.state = 'closed';
      stopHeartbeat();
      opts.logger.warn(
        { code: event.code, reason: event.reason },
        'tape-reader.ws.closed',
      );
      ws = null;
      if (!stopped) {
        stats.reconnects += 1;
        scheduleReconnect();
      }
    };
  };

  const start = async (): Promise<void> => {
    stopped = false;
    connect();
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    stopHeartbeat();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close(1000, 'shutdown');
    }
    ws = null;
  };

  return {
    start,
    stop,
    getStats: (): ClobWsStats => ({ ...stats }),
  };
};
