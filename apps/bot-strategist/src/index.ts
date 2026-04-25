import { z } from 'zod';
import { CommonEnvSchema, RiskEnvSchema, loadEnv } from '@polymarket-bot/config';
import { createBus, bookSnapshotPattern } from '@polymarket-bot/bus';
import {
  Channels,
  type ExecutionOrder,
  type MarketSignal,
  type OracleSignal,
  type OrderBookSnapshot,
} from '@polymarket-bot/contracts';
import { createLogger } from '@polymarket-bot/logger';
import { startHealthServer } from '@polymarket-bot/health';
import {
  detectNewsArbitrage,
  detectSpreadCapture,
  detectSumToOneArb,
  isMaterialUpdate,
  parseNewsMappings,
  signalKey,
  type MarketBookPair,
  type NewsAnalyzerConfig,
} from './analyzers';

/**
 * Bot Strategist (The Brain).
 *
 * Phase 1 analyzers:
 *   - SUM_TO_ONE_ARBITRAGE: detect when YES + NO best prices break the
 *     probability constraint, emit signals for both legs.
 *   - SPREAD_CAPTURE       : when a market's spread is wider than the
 *     configured floor, suggest a Maker quote at midPrice.
 *
 * Phase 2-4 (later plans):
 *   - News arbitrage off `oracle:signals`.
 *   - Optimistic bias model.
 *   - Inventory-aware sizing & circuit breakers.
 */

const EnvSchema = CommonEnvSchema.merge(RiskEnvSchema).extend({
  HEALTH_PORT_STRATEGIST: z.coerce.number().int().positive().default(7003),
  STRATEGIST_SUM_TO_ONE_EDGE: z.coerce.number().nonnegative().default(0.01),
  STRATEGIST_SPREAD_MIN: z.coerce.number().nonnegative().default(0.04),
  STRATEGIST_SIGNAL_TTL_MS: z.coerce.number().int().positive().default(5000),
  STRATEGIST_DEDUPE_PRICE_EPSILON: z.coerce.number().nonnegative().default(0.005),
  STRATEGIST_MIN_REPEAT_INTERVAL_MS: z.coerce.number().int().nonnegative().default(500),
  STRATEGIST_NEWS_MIN_IMPACT: z.coerce.number().min(0).max(1).default(0.4),
  STRATEGIST_NEWS_TTL_MS: z.coerce.number().int().positive().default(8000),
  STRATEGIST_NEWS_FAIR_NUDGE: z.coerce.number().nonnegative().default(0.05),
  STRATEGIST_NEWS_TOPIC_MARKETS: z.string().default(''),
  /**
   * Auto-execution bridge. When true, every successfully published
   * `MarketSignal` is also translated into an `ExecutionOrder` and pushed to
   * `executor:orders`. Defaults OFF in production — only enable when the
   * executor is in `simulation` mode or you've fully reviewed sizing.
   */
  STRATEGIST_AUTOEXECUTE: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
  /** Cap per autoexec order in USDC (further bounded by MAX_CAPITAL_PER_TRADE_USDC). */
  STRATEGIST_AUTOEXEC_MAX_SIZE_USDC: z.coerce.number().positive().default(20),
  /** TTL for autoexec orders. Shorter than the signal TTL so we don't carry stale ideas. */
  STRATEGIST_AUTOEXEC_TTL_MS: z.coerce.number().int().positive().default(5_000),
});

const env = loadEnv(EnvSchema);
const logger = createLogger({
  service: 'bot-strategist',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

interface SignalRecord {
  signal: MarketSignal;
  emittedAt: number;
}

const main = async (): Promise<void> => {
  logger.info(
    {
      env: env.NODE_ENV,
      maxCapital: env.MAX_CAPITAL_PER_TRADE_USDC,
      stopLoss: env.DAILY_STOP_LOSS_USDC,
      thresholds: {
        sumToOneEdge: env.STRATEGIST_SUM_TO_ONE_EDGE,
        spreadMin: env.STRATEGIST_SPREAD_MIN,
      },
    },
    'bot-strategist.boot',
  );

  const bus = createBus({
    redis: { url: env.REDIS_URL, connectionName: 'bot-strategist' },
    logger,
  });

  const books = new Map<string, MarketBookPair>();
  const lastEmittedByKey = new Map<string, SignalRecord>();
  const lastOracleByTopic = new Map<string, OracleSignal>();
  let snapshotsConsumed = 0;
  let oracleConsumed = 0;
  let oracleSkipped = 0;
  let signalsEmitted = 0;
  let signalsSuppressed = 0;
  let autoExecSent = 0;
  let autoExecSkipped = 0;
  let autoExecFailed = 0;
  let lastSnapshotAt: number | null = null;
  let lastOracleAt: number | null = null;
  let lastSignalAt: number | null = null;
  let lastAutoExecAt: number | null = null;

  const newsMappings = parseNewsMappings(env.STRATEGIST_NEWS_TOPIC_MARKETS);
  const newsConfig: NewsAnalyzerConfig = {
    minImpact: env.STRATEGIST_NEWS_MIN_IMPACT,
    ttlMs: env.STRATEGIST_NEWS_TTL_MS,
    fairPriceNudge: env.STRATEGIST_NEWS_FAIR_NUDGE,
    mappings: newsMappings,
  };

  const thresholds = {
    sumToOneEdge: env.STRATEGIST_SUM_TO_ONE_EDGE,
    spreadCaptureMin: env.STRATEGIST_SPREAD_MIN,
    signalTtlMs: env.STRATEGIST_SIGNAL_TTL_MS,
  };

  const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

  /**
   * Translate a strategist signal into a post-only execution order so the
   * executor (simulation by default) has something to chew on.
   *
   *  - Side derived from `metadata.direction` (BUY_BOTH/BUY_YES/BUY_NO/MAKE_BID
   *    → BUY; SELL_* → SELL; otherwise BUY).
   *  - assetId pulled from the cached book snapshot for that outcome — without
   *    it the executor cannot route the order, so we skip and bump
   *    `autoExecSkipped`.
   *  - Size capped by `STRATEGIST_AUTOEXEC_MAX_SIZE_USDC` AND
   *    `MAX_CAPITAL_PER_TRADE_USDC` (the executor enforces the same cap; we
   *    pre-clamp here so dashboards show a meaningful number).
   *  - postOnly=true so we never accidentally take liquidity even if the book
   *    snapshot the strategist used is slightly stale.
   */
  const autoExecute = async (signal: MarketSignal): Promise<void> => {
    if (!env.STRATEGIST_AUTOEXECUTE) return;
    const pair = books.get(signal.marketId);
    const snap = signal.outcome === 'YES' ? pair?.yes : pair?.no;
    if (!snap || !snap.assetId) {
      autoExecSkipped += 1;
      return;
    }
    const direction = String(signal.metadata?.['direction'] ?? '').toUpperCase();
    const side: 'BUY' | 'SELL' = direction.startsWith('SELL') ? 'SELL' : 'BUY';
    const sizeBudgetUsdc = Math.min(
      env.MAX_CAPITAL_PER_TRADE_USDC,
      env.STRATEGIST_AUTOEXEC_MAX_SIZE_USDC,
    );
    const safeFair = clamp(signal.fairPrice, 0.01, 0.99);
    const size = Math.max(1, Math.floor(sizeBudgetUsdc / safeFair));

    const order: ExecutionOrder = {
      id: `auto-${signal.marketId.slice(2, 10)}-${signal.outcome}-${signal.reason}-${signal.timestamp}`,
      marketId: signal.marketId,
      assetId: snap.assetId,
      outcome: signal.outcome,
      side,
      price: safeFair,
      size,
      type: 'LIMIT',
      timeInForce: 'GTC',
      postOnly: true,
      ttlMs: env.STRATEGIST_AUTOEXEC_TTL_MS,
      createdAt: signal.timestamp,
    };
    try {
      await bus.publish(Channels.executorOrders, order);
      autoExecSent += 1;
      lastAutoExecAt = Date.now();
      logger.debug(
        { orderId: order.id, side, size, price: order.price, reason: signal.reason },
        'strategist.autoexec.sent',
      );
    } catch (err) {
      autoExecFailed += 1;
      logger.warn({ err, orderId: order.id }, 'strategist.autoexec.publish.failed');
    }
  };

  const tryEmit = async (signal: MarketSignal): Promise<void> => {
    const key = signalKey(signal);
    const prev = lastEmittedByKey.get(key);
    const now = signal.timestamp;
    if (
      prev &&
      now - prev.emittedAt < env.STRATEGIST_MIN_REPEAT_INTERVAL_MS &&
      !isMaterialUpdate(prev.signal, signal, env.STRATEGIST_DEDUPE_PRICE_EPSILON)
    ) {
      signalsSuppressed += 1;
      return;
    }
    lastEmittedByKey.set(key, { signal, emittedAt: now });
    try {
      await bus.publish(Channels.strategistSignals, signal);
      signalsEmitted += 1;
      lastSignalAt = now;
      logger.info(
        {
          marketId: signal.marketId,
          outcome: signal.outcome,
          reason: signal.reason,
          fairPrice: signal.fairPrice,
          confidence: signal.confidence,
          metadata: signal.metadata,
        },
        'strategist.signal.emitted',
      );
      await autoExecute(signal);
    } catch (err) {
      logger.warn({ err, key }, 'strategist.signal.publish.failed');
    }
  };

  const handleSnapshot = async (
    channel: string,
    payload: OrderBookSnapshot,
  ): Promise<void> => {
    snapshotsConsumed += 1;
    lastSnapshotAt = Date.now();

    const pair = books.get(payload.marketId) ?? { marketId: payload.marketId };
    if (payload.outcome === 'YES') pair.yes = payload;
    else pair.no = payload;
    books.set(payload.marketId, pair);

    const now = Date.now();

    const arbSignals = detectSumToOneArb(pair, thresholds, now);
    for (const signal of arbSignals) {
      await tryEmit(signal);
    }

    const spreadSignal = detectSpreadCapture(payload, thresholds, now);
    if (spreadSignal) {
      await tryEmit(spreadSignal);
    }

    void channel;
  };

  await bus.psubscribe(bookSnapshotPattern, (channel, payload) => {
    handleSnapshot(channel, payload).catch((err: unknown) =>
      logger.error({ err, channel }, 'strategist.snapshot.handler.failed'),
    );
  });
  logger.info({ pattern: bookSnapshotPattern }, 'strategist.subscribed');

  const handleOracle = async (payload: OracleSignal): Promise<void> => {
    oracleConsumed += 1;
    lastOracleAt = Date.now();
    lastOracleByTopic.set(payload.topic, payload);

    if (newsConfig.mappings.length === 0) {
      oracleSkipped += 1;
      return;
    }
    const signals = detectNewsArbitrage(payload, newsConfig, books, Date.now());
    if (signals.length === 0) {
      oracleSkipped += 1;
      return;
    }
    for (const signal of signals) {
      await tryEmit(signal);
    }
  };

  await bus.subscribe(Channels.oracleSignals, (payload) => {
    handleOracle(payload).catch((err: unknown) =>
      logger.error({ err }, 'strategist.oracle.handler.failed'),
    );
  });
  logger.info(
    {
      channel: Channels.oracleSignals,
      mappings: newsConfig.mappings.length,
      minImpact: newsConfig.minImpact,
    },
    'strategist.oracle.subscribed',
  );

  const health = await startHealthServer({
    botId: 'strategist',
    port: env.HEALTH_PORT_STRATEGIST,
    logger,
    details: () => ({
      books: books.size,
      snapshotsConsumed,
      oracleConsumed,
      oracleSkipped,
      signalsEmitted,
      signalsSuppressed,
      lastSnapshotAt,
      lastOracleAt,
      lastSignalAt,
      thresholds,
      autoExecute: {
        enabled: env.STRATEGIST_AUTOEXECUTE,
        sent: autoExecSent,
        skipped: autoExecSkipped,
        failed: autoExecFailed,
        lastSentAt: lastAutoExecAt,
        maxSizeUsdc: env.STRATEGIST_AUTOEXEC_MAX_SIZE_USDC,
        ttlMs: env.STRATEGIST_AUTOEXEC_TTL_MS,
      },
      news: {
        minImpact: newsConfig.minImpact,
        ttlMs: newsConfig.ttlMs,
        mappings: newsConfig.mappings,
        topics: Array.from(lastOracleByTopic.keys()),
      },
    }),
  });
  logger.info({ url: health.url }, 'bot-strategist.health.ready');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'bot-strategist.shutdown');
    await bus.shutdown();
    await health.stop();
    process.exit(0);
  };
  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
};

main().catch((err: unknown) => {
  logger.fatal({ err }, 'bot-strategist.fatal');
  process.exit(1);
});
