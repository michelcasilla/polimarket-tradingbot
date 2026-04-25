import { z } from 'zod';
import {
  CommonEnvSchema,
  PolygonEnvSchema,
  PolymarketEnvSchema,
  RiskEnvSchema,
  loadEnv,
} from '@polymarket-bot/config';
import { createBus, bookSnapshotPattern } from '@polymarket-bot/bus';
import {
  Channels,
  type CancelOrder,
  type CircuitBreakerEvent,
  type ExecutionOrder,
  type ExecutionResult,
  type OrderBookSnapshot,
} from '@polymarket-bot/contracts';
import { createLogger } from '@polymarket-bot/logger';
import { startHealthServer } from '@polymarket-bot/health';
import { createSimulator, type Simulator } from './simulator';
import { createLiveAdapter, type LiveAdapter } from './liveAdapter';

/**
 * Bot Executor (Transaction Manager).
 *
 * Two modes — selected via `EXECUTOR_MODE`:
 *
 *   simulation (default)
 *     Pure in-memory matching engine that uses the latest L2 snapshot per
 *     `marketId:outcome` to decide if an order would cross. Safe by design:
 *     no chain access, no private key required. Honors postOnly, TTL, notional
 *     cap and a daily PnL stop that publishes a `system:circuit-breaker`.
 *
 *   live
 *     Reserved for the real Polymarket CLOB signing flow. This phase fails
 *     fast at boot if the private key is missing/short, then refuses every
 *     order with `live_mode_not_yet_implemented` so no funds can move while
 *     the signer is being built. Wiring is identical so swapping the adapter
 *     in Plan 5 will be a 10-line change.
 */

const ExecutorModeSchema = z.enum(['simulation', 'live']);
type ExecutorMode = z.infer<typeof ExecutorModeSchema>;

const EnvSchema = CommonEnvSchema.merge(PolymarketEnvSchema)
  .merge(PolygonEnvSchema)
  .merge(RiskEnvSchema)
  .extend({
    HEALTH_PORT_EXECUTOR: z.coerce.number().int().positive().default(7004),
    EXECUTOR_MODE: ExecutorModeSchema.default('simulation'),
    EXECUTOR_TAKER_FEE_BPS: z.coerce.number().nonnegative().default(20),
    EXECUTOR_MAKER_FEE_BPS: z.coerce.number().nonnegative().default(0),
    EXECUTOR_DEFAULT_TTL_MS: z.coerce.number().int().positive().default(15_000),
    EXECUTOR_MAX_OPEN_ORDERS: z.coerce.number().int().positive().default(200),
    EXECUTOR_LATENCY_MIN_MS: z.coerce.number().int().nonnegative().default(50),
    EXECUTOR_LATENCY_JITTER_MS: z.coerce.number().int().nonnegative().default(250),
    EXECUTOR_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  });

const env = loadEnv(EnvSchema);
const logger = createLogger({
  service: 'bot-executor',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const buildSimulator = (): Simulator =>
  createSimulator({
    maxNotionalUsdc: env.MAX_CAPITAL_PER_TRADE_USDC,
    takerFeeBps: env.EXECUTOR_TAKER_FEE_BPS,
    makerFeeBps: env.EXECUTOR_MAKER_FEE_BPS,
    dailyStopLossUsdc: env.DAILY_STOP_LOSS_USDC,
    maxOpenOrders: env.EXECUTOR_MAX_OPEN_ORDERS,
    defaultTtlMs: env.EXECUTOR_DEFAULT_TTL_MS,
    latencyMinMs: env.EXECUTOR_LATENCY_MIN_MS,
    latencyJitterMs: env.EXECUTOR_LATENCY_JITTER_MS,
  });

const buildLiveAdapter = (): LiveAdapter => {
  if (!env.POLYGON_PRIVATE_KEY) {
    throw new Error(
      'EXECUTOR_MODE=live requires POLYGON_PRIVATE_KEY (>=64 chars). Refusing to start.',
    );
  }
  return createLiveAdapter({
    privateKey: env.POLYGON_PRIVATE_KEY,
    proxyWallet: env.POLYGON_PROXY_WALLET,
    rpcUrl: env.POLYGON_RPC_URL,
    chainId: env.POLYMARKET_CHAIN_ID,
    clobHttpUrl: env.POLYMARKET_CLOB_HTTP_URL,
  });
};

const main = async (): Promise<void> => {
  const mode: ExecutorMode = env.EXECUTOR_MODE;
  logger.info(
    {
      env: env.NODE_ENV,
      mode,
      hasPrivateKey: Boolean(env.POLYGON_PRIVATE_KEY),
      maxNotional: env.MAX_CAPITAL_PER_TRADE_USDC,
      stopLoss: env.DAILY_STOP_LOSS_USDC,
    },
    'bot-executor.boot',
  );

  const bus = createBus({
    redis: { url: env.REDIS_URL, connectionName: 'bot-executor' },
    logger,
  });

  const simulator = buildSimulator();
  const liveAdapter = mode === 'live' ? buildLiveAdapter() : null;

  let circuitBroadcasted = false;
  let resultsPublished = 0;
  let publishErrors = 0;
  let lastResultAt: number | null = null;

  const publishResult = async (result: ExecutionResult): Promise<void> => {
    try {
      await bus.publish(Channels.executorResults, result);
      resultsPublished += 1;
      lastResultAt = Date.now();
      logger.info(
        {
          orderId: result.orderId,
          marketId: result.marketId,
          status: result.status,
          filledSize: result.filledSize,
          averagePrice: result.averagePrice,
          fees: result.fees,
          error: result.error,
        },
        'executor.result',
      );
    } catch (err) {
      publishErrors += 1;
      logger.error({ err, orderId: result.orderId }, 'executor.result.publish.failed');
    }
  };

  const maybeBroadcastCircuitBreaker = async (): Promise<void> => {
    const stats = simulator.getStats();
    if (!stats.circuitBreakerActive || circuitBroadcasted) return;
    const event: CircuitBreakerEvent = {
      botId: 'executor',
      reason: 'CONSECUTIVE_LOSSES',
      triggeredAt: Date.now(),
      detail: `daily_stop_loss_breached pnl=${stats.estimatedPnlUsdc.toFixed(2)} limit=${env.DAILY_STOP_LOSS_USDC}`,
    };
    try {
      await bus.publish(Channels.systemCircuitBreaker, event);
      circuitBroadcasted = true;
      logger.warn(event, 'executor.circuit_breaker.fired');
    } catch (err) {
      logger.error({ err }, 'executor.circuit_breaker.publish.failed');
    }
  };

  const handleOrder = async (order: ExecutionOrder): Promise<void> => {
    if (mode === 'live' && liveAdapter) {
      const result = liveAdapter.submit(order);
      await publishResult(result);
      return;
    }
    const { immediate, deferred } = simulator.submit(order);
    await publishResult(immediate);
    await maybeBroadcastCircuitBreaker();
    if (deferred) {
      setTimeout(() => {
        publishResult(deferred.result).catch((err: unknown) =>
          logger.error({ err, orderId: deferred.result.orderId }, 'executor.deferred.publish.failed'),
        );
        maybeBroadcastCircuitBreaker().catch(() => undefined);
      }, deferred.afterMs);
    }
  };

  const handleCancel = async (cancel: CancelOrder): Promise<void> => {
    if (mode === 'live' && liveAdapter) {
      await publishResult(liveAdapter.cancel(cancel));
      return;
    }
    const result = simulator.cancel(cancel.orderId);
    if (!result) {
      logger.debug({ orderId: cancel.orderId }, 'executor.cancel.unknown');
      return;
    }
    await publishResult(result);
  };

  const handleSnapshot = async (snapshot: OrderBookSnapshot): Promise<void> => {
    simulator.upsertBook(snapshot);
    const filled = simulator.sweep();
    if (filled.length === 0) return;
    for (const result of filled) {
      await publishResult(result);
    }
    await maybeBroadcastCircuitBreaker();
  };

  await bus.subscribe(Channels.executorOrders, (payload) => {
    handleOrder(payload).catch((err: unknown) =>
      logger.error({ err }, 'executor.order.handler.failed'),
    );
  });
  await bus.subscribe(Channels.executorCancels, (payload) => {
    handleCancel(payload).catch((err: unknown) =>
      logger.error({ err }, 'executor.cancel.handler.failed'),
    );
  });

  if (mode === 'simulation') {
    await bus.psubscribe(bookSnapshotPattern, (_channel, payload) => {
      handleSnapshot(payload).catch((err: unknown) =>
        logger.error({ err }, 'executor.snapshot.handler.failed'),
      );
    });
  }

  const sweepTimer = setInterval(() => {
    if (mode !== 'simulation') return;
    const expired = simulator.sweep();
    if (expired.length === 0) return;
    for (const result of expired) {
      publishResult(result).catch((err: unknown) =>
        logger.error({ err, orderId: result.orderId }, 'executor.sweep.publish.failed'),
      );
    }
    maybeBroadcastCircuitBreaker().catch(() => undefined);
  }, env.EXECUTOR_SWEEP_INTERVAL_MS);

  const health = await startHealthServer({
    botId: 'executor',
    port: env.HEALTH_PORT_EXECUTOR,
    logger,
    details: () => ({
      mode,
      live: liveAdapter ? liveAdapter.getDescriptor() : null,
      liveStats: liveAdapter ? liveAdapter.getStats() : null,
      simulator: simulator.getStats(),
      bus: { resultsPublished, publishErrors, lastResultAt, circuitBroadcasted },
      risk: {
        maxNotionalUsdc: env.MAX_CAPITAL_PER_TRADE_USDC,
        dailyStopLossUsdc: env.DAILY_STOP_LOSS_USDC,
        defaultTtlMs: env.EXECUTOR_DEFAULT_TTL_MS,
        takerFeeBps: env.EXECUTOR_TAKER_FEE_BPS,
        makerFeeBps: env.EXECUTOR_MAKER_FEE_BPS,
      },
    }),
  });
  logger.info({ url: health.url, mode }, 'bot-executor.health.ready');
  if (mode === 'simulation') {
    logger.info(
      { sweepIntervalMs: env.EXECUTOR_SWEEP_INTERVAL_MS },
      'bot-executor.simulation.armed',
    );
  } else {
    logger.warn('bot-executor.live.armed: orders will be rejected until signer lands');
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'bot-executor.shutdown');
    clearInterval(sweepTimer);
    await bus.shutdown();
    await health.stop();
    process.exit(0);
  };
  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
};

main().catch((err: unknown) => {
  logger.fatal({ err }, 'bot-executor.fatal');
  process.exit(1);
});
