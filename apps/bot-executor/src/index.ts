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
  type ExecutorControlCommand,
  type ExecutorStatusEvent,
  type Fill,
  type OrderBookSnapshot,
} from '@polymarket-bot/contracts';
import { createLogger } from '@polymarket-bot/logger';
import { startHealthServer } from '@polymarket-bot/health';
import { createSimulator, type Simulator } from './simulator';
import { createLiveAdapter, type LiveAdapter } from './liveAdapter';
import { createReconciler } from './reconciler';
import { createPositionBook } from './positionBook';
import { createAdverseSelectionDetector } from './adverseSelection';

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
    EXECUTOR_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    EXECUTOR_ADVERSE_HORIZON_MS: z.coerce.number().int().positive().default(30_000),
    EXECUTOR_ADVERSE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
    EXECUTOR_ADVERSE_MIN_SAMPLES: z.coerce.number().int().positive().default(20),
    EXECUTOR_LIVE_DRY_RUN: z
      .union([z.literal('true'), z.literal('false')])
      .default('true')
      .transform((v) => v === 'true'),
    POLYMARKET_SIGNATURE_TYPE: z.enum(['0', '1', '2']).default('2'),
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
  if (!env.POLYGON_PROXY_WALLET) {
    throw new Error('EXECUTOR_MODE=live requires POLYGON_PROXY_WALLET.');
  }
  return createLiveAdapter({
    privateKey: env.POLYGON_PRIVATE_KEY,
    proxyWallet: env.POLYGON_PROXY_WALLET,
    rpcUrl: env.POLYGON_RPC_URL,
    chainId: env.POLYMARKET_CHAIN_ID,
    clobHttpUrl: env.POLYMARKET_CLOB_HTTP_URL,
    redisUrl: env.REDIS_URL,
    dryRun: env.EXECUTOR_LIVE_DRY_RUN,
    signatureType: Number(env.POLYMARKET_SIGNATURE_TYPE) as 0 | 1 | 2,
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
  if (liveAdapter) await liveAdapter.init();
  const positionBook = createPositionBook({ redisUrl: env.REDIS_URL });

  let circuitBroadcasted = false;
  let resultsPublished = 0;
  let publishErrors = 0;
  let lastResultAt: number | null = null;

  /** In-memory pause: reject new orders and optionally cancel resting book (simulation). */
  let paused = false;
  let pausedSince = 0;
  let resumeSince = Date.now();
  const localLiveOpenOrderIds = new Set<string>();
  const latestMids = new Map<string, number>();
  const adverseSelection = createAdverseSelectionDetector({
    bus,
    logger,
    horizonMs: env.EXECUTOR_ADVERSE_HORIZON_MS,
    threshold: env.EXECUTOR_ADVERSE_THRESHOLD,
    minSamples: env.EXECUTOR_ADVERSE_MIN_SAMPLES,
    getMidPrice: (marketId, outcome) => latestMids.get(`${marketId}:${outcome}`) ?? null,
  });

  const publishStatus = async (lastReason: string | null): Promise<void> => {
    const event: ExecutorStatusEvent = {
      paused,
      since: paused ? pausedSince : resumeSince,
      openOrderCount: mode === 'simulation' ? simulator.getOpenOrderIds().length : 0,
      mode,
      lastReason,
    };
    try {
      await bus.publish(Channels.systemExecutorStatus, event);
    } catch (err) {
      logger.error({ err }, 'executor.status.publish.failed');
    }
  };

  const publishResult = async (result: ExecutionResult): Promise<void> => {
    try {
      const payload: ExecutionResult = { ...result, executorMode: mode };
      await bus.publish(Channels.executorResults, payload);
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
      if (result.status === 'FILLED' && result.averagePrice !== undefined && result.outcome && result.side) {
        const fill: Fill = {
          id: `${result.orderId}:${result.timestamp}`,
          orderId: result.orderId,
          signalId: result.signalId,
          marketId: result.marketId,
          outcome: result.outcome,
          side: result.side,
          size: result.filledSize,
          price: result.averagePrice,
          feesUsdc: result.fees ?? 0,
          isMaker: result.error !== 'post_only_would_cross',
          timestamp: result.timestamp,
        };
        await bus.publish(Channels.executorFills, fill);
        const position = await positionBook.applyFill(fill);
        await bus.publish(Channels.executorPositions, position);
        adverseSelection.ingestFill(fill, result.averagePrice);
      }
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

  const rejectPausedOrder = async (order: ExecutionOrder): Promise<void> => {
    const result: ExecutionResult = {
      orderId: order.id,
      marketId: order.marketId,
      status: 'REJECTED',
      filledSize: 0,
      error: 'executor_paused',
      timestamp: Date.now(),
      outcome: order.outcome,
      side: order.side,
      requestedPrice: order.price,
      requestedSize: order.size,
    };
    if (order.signalReason !== undefined) result.signalReason = order.signalReason;
    if (order.ttlMs !== undefined) result.expiresAt = order.createdAt + order.ttlMs;
    await publishResult(result);
  };

  const handleControl = async (cmd: ExecutorControlCommand): Promise<void> => {
    if (cmd.type === 'PAUSE') {
      paused = true;
      pausedSince = Date.now();
      if (mode === 'simulation') {
        const ids = [...simulator.getOpenOrderIds()];
        for (const orderId of ids) {
          const result = simulator.cancel(orderId);
          if (result) {
            await publishResult({ ...result, error: 'executor_paused' });
          }
        }
      }
      await publishStatus(cmd.reason ?? 'dashboard_panic');
      return;
    }
    if (cmd.type === 'RESUME') {
      paused = false;
      resumeSince = Date.now();
      await publishStatus(cmd.reason ?? 'dashboard_resume');
    }
  };

  const handleOrder = async (order: ExecutionOrder): Promise<void> => {
    if (paused) {
      await rejectPausedOrder(order);
      return;
    }
    if (mode === 'live' && liveAdapter) {
      const result = await liveAdapter.submit(order);
      await publishResult(result);
      if (result.status === 'PLACED') localLiveOpenOrderIds.add(result.orderId);
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
      const result = await liveAdapter.cancel(cancel);
      await publishResult(result);
      if (result.status === 'CANCELLED') localLiveOpenOrderIds.delete(cancel.orderId);
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
    if (snapshot.midPrice !== null) latestMids.set(`${snapshot.marketId}:${snapshot.outcome}`, snapshot.midPrice);
    const marked = positionBook.applyMark(snapshot.marketId, snapshot.outcome, snapshot.midPrice ?? 0.5);
    if (marked) await bus.publish(Channels.executorPositions, marked);
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
  await bus.subscribe(Channels.executorControl, (payload) => {
    handleControl(payload).catch((err: unknown) =>
      logger.error({ err }, 'executor.control.handler.failed'),
    );
  });

  if (mode === 'simulation') {
    await bus.psubscribe(bookSnapshotPattern, (_channel, payload) => {
      handleSnapshot(payload).catch((err: unknown) =>
        logger.error({ err }, 'executor.snapshot.handler.failed'),
      );
    });
  }

  const reconciler =
    mode === 'live' && liveAdapter
      ? createReconciler({
          intervalMs: env.EXECUTOR_RECONCILIATION_INTERVAL_MS,
          bus,
          logger,
          liveAdapter,
          getLocalOpenOrderIds: () => Array.from(localLiveOpenOrderIds),
        })
      : null;
  reconciler?.start();

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

  const statusHeartbeatTimer = setInterval(() => {
    void publishStatus(null);
  }, 5_000);

  await publishStatus(null);

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
      paused,
      pausedSince,
      resumeSince,
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
    clearInterval(statusHeartbeatTimer);
    reconciler?.stop();
    await bus.shutdown();
    await positionBook.shutdown();
    if (liveAdapter) await liveAdapter.shutdown();
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
