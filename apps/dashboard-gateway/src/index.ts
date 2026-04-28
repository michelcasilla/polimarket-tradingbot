import type { ServerWebSocket } from 'bun';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { CommonEnvSchema, loadEnv } from '@polymarket-bot/config';
import {
  createBus,
  type MessageBus,
  type Unsubscribe,
  bookDeltaPattern,
  bookSnapshotPattern,
} from '@polymarket-bot/bus';
import { Channels, type StaticChannelName } from '@polymarket-bot/contracts';
import { createLogger } from '@polymarket-bot/logger';
import { startHealthServer } from '@polymarket-bot/health';

const EnvSchema = CommonEnvSchema.extend({
  HEALTH_PORT_DASHBOARD_GATEWAY: z.coerce.number().int().positive().default(7005),
  DASHBOARD_WS_PORT: z.coerce.number().int().positive().default(7010),
  DASHBOARD_GATEWAY_DB_PATH: z.string().default('./data/dashboard-gateway.sqlite'),
});

const env = loadEnv(EnvSchema);
const logger = createLogger({
  service: 'dashboard-gateway',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

type LiveEventType = 'SYSTEM' | 'HEALTH' | 'LOG';

interface LiveEvent {
  type: LiveEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

const clients = new Set<ServerWebSocket<unknown>>();
let heartbeatTimer: Timer | undefined;
const activeSubscriptions: Unsubscribe[] = [];
let busConnected = false;
const dbDir = dirname(env.DASHBOARD_GATEWAY_DB_PATH);
mkdirSync(dbDir, { recursive: true });
const db = new Database(env.DASHBOARD_GATEWAY_DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS execution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  status TEXT NOT NULL,
  filled_size REAL NOT NULL DEFAULT 0,
  average_price REAL,
  fees REAL,
  signal_reason TEXT,
  side TEXT,
  outcome TEXT,
  timestamp_ms INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_events_order_ts ON execution_events(order_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_execution_events_reason ON execution_events(signal_reason);

CREATE TABLE IF NOT EXISTS position_snapshots (
  market_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  net_size REAL NOT NULL DEFAULT 0,
  average_entry_price REAL NOT NULL DEFAULT 0,
  realized_pnl_usdc REAL NOT NULL DEFAULT 0,
  unrealized_pnl_usdc REAL NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  source TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (market_id, outcome)
);
`);

const insertExecutionStmt = db.prepare(`
INSERT INTO execution_events (
  order_id, market_id, status, filled_size, average_price, fees,
  signal_reason, side, outcome, timestamp_ms, payload_json
) VALUES (
  $order_id, $market_id, $status, $filled_size, $average_price, $fees,
  $signal_reason, $side, $outcome, $timestamp_ms, $payload_json
)
`);

const upsertPositionStmt = db.prepare(`
INSERT INTO position_snapshots (
  market_id, outcome, net_size, average_entry_price, realized_pnl_usdc,
  unrealized_pnl_usdc, updated_at_ms, source, payload_json
) VALUES (
  $market_id, $outcome, $net_size, $average_entry_price, $realized_pnl_usdc,
  $unrealized_pnl_usdc, $updated_at_ms, $source, $payload_json
)
ON CONFLICT(market_id, outcome) DO UPDATE SET
  net_size = excluded.net_size,
  average_entry_price = excluded.average_entry_price,
  realized_pnl_usdc = excluded.realized_pnl_usdc,
  unrealized_pnl_usdc = excluded.unrealized_pnl_usdc,
  updated_at_ms = excluded.updated_at_ms,
  source = excluded.source,
  payload_json = excluded.payload_json
`);

const latestOrderStatusesStmt = db.prepare(`
SELECT e.order_id, e.status
FROM execution_events e
JOIN (
  SELECT order_id, MAX(timestamp_ms) AS max_ts
  FROM execution_events
  GROUP BY order_id
) latest
  ON latest.order_id = e.order_id AND latest.max_ts = e.timestamp_ms
`);

const reasonAttributionStmt = db.prepare(`
SELECT
  COALESCE(signal_reason, 'unknown') AS reason,
  COUNT(*) AS fills,
  SUM(COALESCE(fees, 0)) AS fees_total,
  SUM(COALESCE(filled_size, 0) * COALESCE(average_price, 0)) AS notional_total
FROM execution_events
WHERE status = 'FILLED'
GROUP BY COALESCE(signal_reason, 'unknown')
ORDER BY fills DESC
`);

const positionTotalsStmt = db.prepare(`
SELECT
  SUM(realized_pnl_usdc) AS realized_total,
  SUM(unrealized_pnl_usdc) AS unrealized_total
FROM position_snapshots
`);

const fillLedgerStmt = db.prepare(`
SELECT
  id,
  order_id,
  market_id,
  status,
  COALESCE(signal_reason, 'unknown') AS reason,
  COALESCE(fees, 0) AS fees,
  timestamp_ms,
  side,
  outcome
FROM execution_events
WHERE status = 'FILLED'
ORDER BY timestamp_ms ASC, id ASC
`);

const persistEvent = (channel: string, payload: unknown): void => {
  const data = (payload ?? {}) as Record<string, unknown>;
  if (channel === Channels.executorResults) {
    if (typeof data.orderId !== 'string' || typeof data.marketId !== 'string' || typeof data.status !== 'string') {
      return;
    }
    insertExecutionStmt.run({
      $order_id: data.orderId,
      $market_id: data.marketId,
      $status: data.status,
      $filled_size: typeof data.filledSize === 'number' ? data.filledSize : 0,
      $average_price: typeof data.averagePrice === 'number' ? data.averagePrice : null,
      $fees: typeof data.fees === 'number' ? data.fees : null,
      $signal_reason: typeof data.signalReason === 'string' ? data.signalReason : null,
      $side: typeof data.side === 'string' ? data.side : null,
      $outcome: typeof data.outcome === 'string' ? data.outcome : null,
      $timestamp_ms: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
      $payload_json: JSON.stringify(data),
    });
    return;
  }
  if (channel === Channels.executorPositions) {
    if (typeof data.marketId !== 'string' || typeof data.outcome !== 'string') {
      return;
    }
    upsertPositionStmt.run({
      $market_id: data.marketId,
      $outcome: data.outcome,
      $net_size: typeof data.netSize === 'number' ? data.netSize : 0,
      $average_entry_price: typeof data.averageEntryPrice === 'number' ? data.averageEntryPrice : 0,
      $realized_pnl_usdc: typeof data.realizedPnlUsdc === 'number' ? data.realizedPnlUsdc : 0,
      $unrealized_pnl_usdc: typeof data.unrealizedPnlUsdc === 'number' ? data.unrealizedPnlUsdc : 0,
      $updated_at_ms: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
      $source: typeof data.source === 'string' ? data.source : null,
      $payload_json: JSON.stringify(data),
    });
  }
};

const readPnlSummary = () => {
  const latestStatuses = latestOrderStatusesStmt.all() as Array<{ order_id: string; status: string }>;
  let open = 0;
  let closed = 0;
  const lifecycle = { filled: 0, cancelled: 0, rejected: 0, expired: 0 };
  for (const row of latestStatuses) {
    if (row.status === 'PENDING' || row.status === 'PLACED' || row.status === 'PARTIALLY_FILLED') open += 1;
    else closed += 1;
    if (row.status === 'FILLED') lifecycle.filled += 1;
    if (row.status === 'CANCELLED') lifecycle.cancelled += 1;
    if (row.status === 'REJECTED') lifecycle.rejected += 1;
    if (row.status === 'EXPIRED') lifecycle.expired += 1;
    void row.order_id;
  }

  const attribution = (reasonAttributionStmt.all() as Array<{
    reason: string;
    fills: number;
    fees_total: number | null;
    notional_total: number | null;
  }>).map((row) => ({
    reason: row.reason,
    fills: row.fills,
    feesTotal: row.fees_total ?? 0,
    notionalTotal: row.notional_total ?? 0,
    // Conservative proxy until we have full close-trade accounting.
    realizedPnlProxy: -(row.fees_total ?? 0),
  }));

  const posTotals = (positionTotalsStmt.get() as { realized_total: number | null; unrealized_total: number | null } | null) ?? {
    realized_total: 0,
    unrealized_total: 0,
  };

  return {
    updatedAt: Date.now(),
    orders: {
      total: latestStatuses.length,
      open,
      closed,
      lifecycle,
    },
    pnl: {
      realizedTotal: posTotals.realized_total ?? 0,
      unrealizedTotal: posTotals.unrealized_total ?? 0,
      netTotal: (posTotals.realized_total ?? 0) + (posTotals.unrealized_total ?? 0),
    },
    attribution,
  };
};

const readPnlLedger = (limit: number) => {
  const rows = fillLedgerStmt.all() as Array<{
    id: number;
    order_id: string;
    market_id: string;
    status: string;
    reason: string;
    fees: number;
    timestamp_ms: number;
    side: string | null;
    outcome: string | null;
  }>;
  let cumulative = 0;
  const withCumulative = rows.map((row) => {
    const pnlDelta = -Math.abs(row.fees ?? 0);
    cumulative += pnlDelta;
    return {
      id: row.id,
      orderId: row.order_id,
      marketId: row.market_id,
      status: row.status,
      reason: row.reason,
      fees: row.fees ?? 0,
      pnlDelta,
      cumulative,
      timestamp: row.timestamp_ms,
      side: row.side,
      outcome: row.outcome,
    };
  });
  return withCumulative.slice(Math.max(0, withCumulative.length - limit)).reverse();
};

const broadcast = (event: LiveEvent): void => {
  const text = JSON.stringify(event);
  for (const ws of clients) {
    ws.send(text);
  }
};

const corsControlHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const startWsServer = (bus: MessageBus) =>
  Bun.serve({
    port: env.DASHBOARD_WS_PORT,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (req.method === 'OPTIONS' && url.pathname.startsWith('/control/')) {
        return new Response(null, { status: 204, headers: corsControlHeaders });
      }

      if (req.method === 'POST' && url.pathname === '/control/executor/panic') {
        await bus.publish(Channels.executorControl, {
          type: 'PAUSE',
          reason: 'dashboard_panic',
          requestedAt: Date.now(),
        });
        return Response.json({ ok: true }, { headers: corsControlHeaders });
      }

      if (req.method === 'POST' && url.pathname === '/control/executor/resume') {
        await bus.publish(Channels.executorControl, {
          type: 'RESUME',
          reason: 'dashboard_resume',
          requestedAt: Date.now(),
        });
        return Response.json({ ok: true }, { headers: corsControlHeaders });
      }

      const cancelMatch = url.pathname.match(/^\/control\/executor\/orders\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && cancelMatch) {
        let body: unknown = {};
        try {
          body = await req.json();
        } catch {
          body = {};
        }
        const marketId =
          typeof body === 'object' &&
          body !== null &&
          typeof (body as Record<string, unknown>)['marketId'] === 'string'
            ? ((body as Record<string, unknown>)['marketId'] as string)
            : null;
        if (!marketId) {
          return Response.json(
            { ok: false, error: 'marketId required in JSON body' },
            { status: 400, headers: corsControlHeaders },
          );
        }
        const orderId = decodeURIComponent(cancelMatch[1]!);
        await bus.publish(Channels.executorCancels, {
          orderId,
          marketId,
          reason: 'DASHBOARD',
          requestedAt: Date.now(),
        });
        return Response.json({ ok: true }, { headers: corsControlHeaders });
      }

      if (url.pathname === '/ws') {
        if (server.upgrade(req)) {
          return undefined;
        }
        return new Response('Upgrade failed', { status: 400 });
      }
      if (url.pathname === '/status') {
        return Response.json({
          clients: clients.size,
          wsPort: env.DASHBOARD_WS_PORT,
          healthPort: env.HEALTH_PORT_DASHBOARD_GATEWAY,
        });
      }
      if (req.method === 'GET' && url.pathname === '/analytics/pnl-summary') {
        return Response.json(readPnlSummary(), {
          headers: { ...corsControlHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
        });
      }
      if (req.method === 'GET' && url.pathname === '/analytics/pnl-ledger') {
        const limitRaw = Number(url.searchParams.get('limit') ?? '200');
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 200;
        return Response.json(
          {
            updatedAt: Date.now(),
            rows: readPnlLedger(limit),
          },
          {
            headers: { ...corsControlHeaders, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
          },
        );
      }
      return new Response('dashboard-gateway ws server', { status: 200 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(
          JSON.stringify({
            type: 'SYSTEM',
            timestamp: Date.now(),
            payload: {
              message: 'connected',
              clients: clients.size,
            },
          } satisfies LiveEvent),
        );
      },
      message(_ws, _message) {
        // Bidirectional protocol is intentionally minimal for MVP.
      },
      close(ws) {
        clients.delete(ws);
      },
    },
  });

const main = async (): Promise<void> => {
  logger.info({ env: env.NODE_ENV }, 'dashboard-gateway.boot');

  const bus = createBus({
    redis: {
      url: env.REDIS_URL,
      connectionName: 'dashboard-gateway',
    },
    logger,
  });

  const subscribeStaticChannel = async (channel: StaticChannelName): Promise<void> => {
    const unsubscribe = await bus.subscribe(channel, (payload) => {
      persistEvent(channel, payload);
      broadcast({
        type: channel === Channels.systemHealth ? 'HEALTH' : 'LOG',
        timestamp: Date.now(),
        payload: {
          source: 'redis',
          channel,
          data: payload as Record<string, unknown>,
        },
      });
    });
    activeSubscriptions.push(unsubscribe);
  };

  const subscribeBus = async (): Promise<void> => {
    await subscribeStaticChannel(Channels.systemHealth);
    await subscribeStaticChannel(Channels.marketsMetadata);
    await subscribeStaticChannel(Channels.oracleSignals);
    await subscribeStaticChannel(Channels.strategistSignals);
    await subscribeStaticChannel(Channels.executorResults);
    await subscribeStaticChannel(Channels.executorPositions);
    await subscribeStaticChannel(Channels.executorFills);
    await subscribeStaticChannel(Channels.executorReconciliation);
    await subscribeStaticChannel(Channels.executorAdverseSelection);
    await subscribeStaticChannel(Channels.strategistRewardScores);
    await subscribeStaticChannel(Channels.systemCircuitBreaker);
    await subscribeStaticChannel(Channels.systemExecutorStatus);

    const unsubscribeBookSnapshot = await bus.psubscribe(bookSnapshotPattern, (channel, payload) => {
      broadcast({
        type: 'LOG',
        timestamp: Date.now(),
        payload: {
          source: 'redis',
          channel,
          data: payload as Record<string, unknown>,
        },
      });
    });
    activeSubscriptions.push(unsubscribeBookSnapshot);

    const unsubscribeBookDelta = await bus.psubscribe(bookDeltaPattern, (channel, payload) => {
      broadcast({
        type: 'LOG',
        timestamp: Date.now(),
        payload: {
          source: 'redis',
          channel,
          data: payload as Record<string, unknown>,
        },
      });
    });
    activeSubscriptions.push(unsubscribeBookDelta);

    busConnected = true;
    logger.info(
      {
        channels: [
          Channels.systemHealth,
          Channels.marketsMetadata,
          Channels.oracleSignals,
          Channels.strategistSignals,
          Channels.executorResults,
          Channels.executorPositions,
          Channels.executorFills,
          Channels.executorReconciliation,
          Channels.executorAdverseSelection,
          Channels.strategistRewardScores,
          Channels.systemCircuitBreaker,
          Channels.systemExecutorStatus,
          bookSnapshotPattern,
          bookDeltaPattern,
        ],
      },
      'dashboard-gateway.redis.subscribed',
    );
  };

  await subscribeBus().catch((err: unknown) => {
    logger.error({ err }, 'dashboard-gateway.redis.subscribe.failed');
    logger.warn(
      'dashboard-gateway.redis.offline_mode: websocket stays up, but no Redis events will be streamed',
    );
  });

  const health = await startHealthServer({
    botId: 'dashboard-gateway',
    port: env.HEALTH_PORT_DASHBOARD_GATEWAY,
    logger,
    details: () => ({
      wsClients: clients.size,
      wsPort: env.DASHBOARD_WS_PORT,
      redisConnected: busConnected,
      activeSubscriptions: activeSubscriptions.length,
    }),
  });
  logger.info({ url: health.url }, 'dashboard-gateway.health.ready');

  const wsServer = startWsServer(bus);
  logger.info(
    { wsUrl: `ws://localhost:${env.DASHBOARD_WS_PORT}/ws` },
    'dashboard-gateway.ws.ready',
  );

  heartbeatTimer = setInterval(() => {
    broadcast({
      type: 'HEALTH',
      timestamp: Date.now(),
      payload: {
        clients: clients.size,
        source: 'dashboard-gateway',
      },
    });
  }, 1500);

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'dashboard-gateway.shutdown');
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    await Promise.allSettled(activeSubscriptions.splice(0).map((unsubscribe) => unsubscribe()));
    await bus.shutdown();
    wsServer.stop();
    await health.stop();
    process.exit(0);
  };

  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
};

main().catch((err: unknown) => {
  logger.fatal({ err }, 'dashboard-gateway.fatal');
  process.exit(1);
});
