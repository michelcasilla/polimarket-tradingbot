import { z } from 'zod';
import { CommonEnvSchema, loadEnv } from '@polymarket-bot/config';
import { createBus } from '@polymarket-bot/bus';
import { Channels, type OracleSignal } from '@polymarket-bot/contracts';
import { createLogger } from '@polymarket-bot/logger';
import { startHealthServer } from '@polymarket-bot/health';
import { startBinanceClient } from './binanceClient';
import { createPriceDeltaDetector, defaultSymbolToTopic } from './priceDelta';

/**
 * Bot Oracle (Phase 1 — Binance only).
 *
 * Subscribes to Binance combined-stream `<symbol>@ticker` feeds, computes
 * sliding-window % deltas per symbol and publishes `OracleSignal` messages
 * (provider=BINANCE, eventType=PRICE_DELTA) to the `oracle:signals` channel.
 *
 * Future plans add SportRadar, NewsAPI and Twitter providers in this same
 * orchestrator, sharing the publish/dedupe pipeline.
 */

const csv = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = CommonEnvSchema.extend({
  HEALTH_PORT_ORACLE: z.coerce.number().int().positive().default(7001),
  BINANCE_WS_URL: z.string().url().default('wss://stream.binance.com:9443/ws'),
  ORACLE_BINANCE_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
  ORACLE_BINANCE_SYMBOLS: z.string().default('btcusdt,ethusdt,solusdt'),
  ORACLE_BINANCE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  ORACLE_BINANCE_MIN_DELTA_PCT: z.coerce.number().nonnegative().default(0.5),
  ORACLE_BINANCE_SATURATION_PCT: z.coerce.number().positive().default(2.5),
  ORACLE_BINANCE_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(5_000),
});

const env = loadEnv(EnvSchema);
const logger = createLogger({
  service: 'bot-oracle',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const main = async (): Promise<void> => {
  logger.info(
    {
      env: env.NODE_ENV,
      binance: {
        enabled: env.ORACLE_BINANCE_ENABLED,
        symbols: env.ORACLE_BINANCE_SYMBOLS,
        windowMs: env.ORACLE_BINANCE_WINDOW_MS,
        minDeltaPct: env.ORACLE_BINANCE_MIN_DELTA_PCT,
      },
    },
    'bot-oracle.boot',
  );

  const bus = createBus({
    redis: { url: env.REDIS_URL, connectionName: 'bot-oracle' },
    logger,
  });

  const stats = {
    tickersIngested: 0,
    signalsEmitted: 0,
    publishErrors: 0,
    lastSignalAt: null as number | null,
    lastTickerAt: null as number | null,
  };

  let binance: ReturnType<typeof startBinanceClient> | null = null;
  let detector: ReturnType<typeof createPriceDeltaDetector> | null = null;

  if (env.ORACLE_BINANCE_ENABLED) {
    const symbols = csv(env.ORACLE_BINANCE_SYMBOLS).map((s) => s.toLowerCase());
    if (symbols.length === 0) {
      logger.warn('bot-oracle.binance.skip: no symbols configured');
    } else {
      detector = createPriceDeltaDetector({
        windowMs: env.ORACLE_BINANCE_WINDOW_MS,
        minDeltaPct: env.ORACLE_BINANCE_MIN_DELTA_PCT,
        saturationDeltaPct: env.ORACLE_BINANCE_SATURATION_PCT,
        cooldownMs: env.ORACLE_BINANCE_COOLDOWN_MS,
        symbolToTopic: defaultSymbolToTopic,
      });

      const publishSignal = async (signal: OracleSignal): Promise<void> => {
        try {
          await bus.publish(Channels.oracleSignals, signal);
          stats.signalsEmitted += 1;
          stats.lastSignalAt = signal.timestamp;
          logger.info(
            {
              topic: signal.topic,
              impactScore: signal.impactScore,
              raw: signal.rawData,
            },
            'oracle.signal.emitted',
          );
        } catch (err) {
          stats.publishErrors += 1;
          logger.warn({ err, topic: signal.topic }, 'oracle.signal.publish.failed');
        }
      };

      binance = startBinanceClient({
        baseUrl: env.BINANCE_WS_URL,
        symbols,
        logger,
        onTicker: (update) => {
          stats.tickersIngested += 1;
          stats.lastTickerAt = update.eventTime || Date.now();
          const signal = detector!.ingest(update);
          if (signal) {
            void publishSignal(signal);
          }
        },
      });
      await binance.start();
    }
  } else {
    logger.warn('bot-oracle.binance.disabled');
  }

  const health = await startHealthServer({
    botId: 'oracle',
    port: env.HEALTH_PORT_ORACLE,
    logger,
    details: () => ({
      providers: {
        binance: {
          enabled: env.ORACLE_BINANCE_ENABLED,
          stats: binance ? binance.getStats() : null,
          symbols: detector ? detector.getState() : null,
        },
      },
      ...stats,
      thresholds: {
        windowMs: env.ORACLE_BINANCE_WINDOW_MS,
        minDeltaPct: env.ORACLE_BINANCE_MIN_DELTA_PCT,
        saturationPct: env.ORACLE_BINANCE_SATURATION_PCT,
        cooldownMs: env.ORACLE_BINANCE_COOLDOWN_MS,
      },
    }),
  });

  logger.info({ url: health.url }, 'bot-oracle.health.ready');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'bot-oracle.shutdown');
    try {
      if (binance) await binance.stop();
      await bus.shutdown();
      await health.stop();
    } catch (err) {
      logger.error({ err }, 'bot-oracle.shutdown.error');
    }
    process.exit(0);
  };
  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
};

main().catch((err: unknown) => {
  logger.fatal({ err }, 'bot-oracle.fatal');
  process.exit(1);
});
