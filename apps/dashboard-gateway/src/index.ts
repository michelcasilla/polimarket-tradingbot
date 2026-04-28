import type { ServerWebSocket } from 'bun';
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
