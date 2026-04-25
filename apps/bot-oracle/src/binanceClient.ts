import type { Logger } from '@polymarket-bot/logger';

/**
 * Lightweight Binance combined-stream client for `<symbol>@ticker` feeds.
 *
 * Endpoint: wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/...
 *
 * Responsibilities:
 *  - Maintain a single connection covering all configured symbols.
 *  - Auto-reconnect with exponential backoff (max 30s).
 *  - Decode 24h ticker payloads and forward normalized `TickerUpdate`s.
 */

const HEARTBEAT_INTERVAL_MS = 30_000; // Binance closes idle conns at ~3min
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface TickerUpdate {
  symbol: string;
  lastPrice: number;
  priceChange24h: number;
  priceChangePct24h: number;
  volume24h: number;
  eventTime: number;
}

export interface BinanceClientOptions {
  baseUrl: string; // wss://stream.binance.com:9443 (path is appended)
  symbols: string[]; // lowercase, e.g. ["btcusdt", "ethusdt"]
  logger: Logger;
  onTicker: (update: TickerUpdate) => void | Promise<void>;
}

export interface BinanceClientStats {
  connections: number;
  reconnects: number;
  messages: number;
  parseErrors: number;
  lastEventAt: number | null;
  state: 'idle' | 'connecting' | 'open' | 'closed';
}

interface CombinedFrame {
  stream?: string;
  data?: RawTicker;
}

interface RawTicker {
  e?: string; // event type
  s?: string; // symbol
  c?: string; // close (last) price
  p?: string; // price change
  P?: string; // price change %
  v?: string; // base volume
  E?: number; // event time
}

const buildUrl = (baseUrl: string, symbols: string[]): string => {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const stripped = trimmed.endsWith('/ws') ? trimmed.slice(0, -3) : trimmed;
  const streams = symbols.map((s) => `${s.toLowerCase()}@ticker`).join('/');
  return `${stripped}/stream?streams=${streams}`;
};

const parseNumber = (raw: unknown): number | null => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const decodeTicker = (raw: RawTicker): TickerUpdate | null => {
  const symbol = typeof raw.s === 'string' ? raw.s : null;
  const lastPrice = parseNumber(raw.c);
  const priceChange = parseNumber(raw.p);
  const priceChangePct = parseNumber(raw.P);
  const volume = parseNumber(raw.v);
  const eventTime = typeof raw.E === 'number' ? raw.E : Date.now();
  if (!symbol || lastPrice === null) return null;
  return {
    symbol,
    lastPrice,
    priceChange24h: priceChange ?? 0,
    priceChangePct24h: priceChangePct ?? 0,
    volume24h: volume ?? 0,
    eventTime,
  };
};

export const startBinanceClient = (opts: BinanceClientOptions) => {
  if (opts.symbols.length === 0) {
    throw new Error('binance.client.no_symbols');
  }
  const url = buildUrl(opts.baseUrl, opts.symbols);
  const stats: BinanceClientStats = {
    connections: 0,
    reconnects: 0,
    messages: 0,
    parseErrors: 0,
    lastEventAt: null,
    state: 'idle',
  };

  let ws: WebSocket | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = INITIAL_BACKOFF_MS;
  let stopped = false;

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    opts.logger.info({ wait }, 'oracle.binance.reconnect.scheduled');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, wait);
  };

  const handleFrame = async (raw: string): Promise<void> => {
    let parsed: CombinedFrame | RawTicker;
    try {
      parsed = JSON.parse(raw) as CombinedFrame | RawTicker;
    } catch (err) {
      stats.parseErrors += 1;
      opts.logger.warn(
        { err, sample: raw.slice(0, 200) },
        'oracle.binance.parse.failed',
      );
      return;
    }

    const ticker = 'data' in parsed && parsed.data ? parsed.data : (parsed as RawTicker);
    const decoded = decodeTicker(ticker);
    if (!decoded) {
      stats.parseErrors += 1;
      return;
    }
    stats.messages += 1;
    stats.lastEventAt = Date.now();
    try {
      const out = opts.onTicker(decoded);
      if (out instanceof Promise) await out;
    } catch (err) {
      opts.logger.warn(
        { err, symbol: decoded.symbol },
        'oracle.binance.handler.failed',
      );
    }
  };

  const connect = (): void => {
    if (stopped) return;
    stats.state = 'connecting';
    opts.logger.info({ url }, 'oracle.binance.connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      opts.logger.error({ err }, 'oracle.binance.construct.failed');
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      stats.state = 'open';
      stats.connections += 1;
      backoff = INITIAL_BACKOFF_MS;
      opts.logger.info({ symbols: opts.symbols }, 'oracle.binance.open');
      stopHeartbeat();
      // Binance ping/pongs the client every ~3min. We don't need to send our
      // own pings; the WS server handles keepalive. We keep an idle watchdog
      // that bumps a stat counter so the health endpoint exposes liveness.
      heartbeat = setInterval(() => {
        // No-op heartbeat. Liveness is measured by stats.lastEventAt.
      }, HEARTBEAT_INTERVAL_MS);
    };

    socket.onmessage = (msg: MessageEvent) => {
      const data = typeof msg.data === 'string' ? msg.data : msg.data?.toString?.() ?? '';
      void handleFrame(String(data));
    };

    socket.onerror = (event) => {
      opts.logger.warn({ event: String(event) }, 'oracle.binance.error');
    };

    socket.onclose = (event) => {
      stats.state = 'closed';
      stopHeartbeat();
      opts.logger.warn(
        { code: event.code, reason: event.reason },
        'oracle.binance.closed',
      );
      ws = null;
      if (!stopped) {
        stats.reconnects += 1;
        scheduleReconnect();
      }
    };
  };

  return {
    start: async (): Promise<void> => {
      stopped = false;
      connect();
    },
    stop: async (): Promise<void> => {
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
    },
    getStats: (): BinanceClientStats => ({ ...stats }),
  };
};
