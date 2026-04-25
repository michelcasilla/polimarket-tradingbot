import { z } from 'zod';
import { CommonEnvSchema, PolymarketEnvSchema, loadEnv } from '@polymarket-bot/config';
import { createBus } from '@polymarket-bot/bus';
import type { MarketMetadata } from '@polymarket-bot/contracts';
import { createLogger } from '@polymarket-bot/logger';
import { startHealthServer } from '@polymarket-bot/health';
import { discoverMarkets, parseManualTokens, type TrackedToken } from './discovery';
import { startRestPoller } from './restPoller';
import { startClobWsClient } from './wsClient';
import { startMetadataPublisher } from './metadataPublisher';

/**
 * Bot Tape Reader (Polymarket CLOB).
 *
 * Modes (TAPE_READER_MODE):
 *  - `ws`   (default): subscribe to the CLOB market WebSocket, maintain
 *                       L2 books in memory, publish snapshots + deltas.
 *  - `rest`           : poll `/book` on a fixed interval (cold-start fallback).
 *  - `both`           : run REST first to warm up, then keep WS as primary.
 *
 * Token discovery:
 *  - If `TAPE_READER_TOKEN_IDS` is set, parse that list verbatim.
 *  - Otherwise auto-discover the top N markets via `/sampling-markets`.
 */

const ModeSchema = z.enum(['ws', 'rest', 'both']);

const EnvSchema = CommonEnvSchema.merge(PolymarketEnvSchema).extend({
  HEALTH_PORT_TAPE_READER: z.coerce.number().int().positive().default(7002),
  TAPE_READER_TOKEN_IDS: z.string().optional(),
  TAPE_READER_AUTO_DISCOVER_LIMIT: z.coerce.number().int().positive().default(5),
  TAPE_READER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  TAPE_READER_MAX_LEVELS: z.coerce.number().int().positive().default(15),
  TAPE_READER_MODE: ModeSchema.default('ws'),
  TAPE_READER_WS_CUSTOM_FEATURE: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),
  TAPE_READER_METADATA_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
});

const env = loadEnv(EnvSchema);
const logger = createLogger({
  service: 'bot-tape-reader',
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const main = async (): Promise<void> => {
  logger.info(
    {
      env: env.NODE_ENV,
      http: env.POLYMARKET_CLOB_HTTP_URL,
      ws: env.POLYMARKET_CLOB_WS_URL,
      mode: env.TAPE_READER_MODE,
      intervalMs: env.TAPE_READER_POLL_INTERVAL_MS,
    },
    'bot-tape-reader.boot',
  );

  const bus = createBus({
    redis: { url: env.REDIS_URL, connectionName: 'bot-tape-reader' },
    logger,
  });

  let tokens: TrackedToken[] = [];
  let metadata: MarketMetadata[] = [];
  if (env.TAPE_READER_TOKEN_IDS) {
    const result = parseManualTokens(env.TAPE_READER_TOKEN_IDS);
    tokens = result.tokens;
    metadata = result.metadata;
    logger.info({ count: tokens.length }, 'tape-reader.tokens.manual');
  } else {
    try {
      const result = await discoverMarkets(
        env.POLYMARKET_CLOB_HTTP_URL,
        env.TAPE_READER_AUTO_DISCOVER_LIMIT,
        logger,
      );
      tokens = result.tokens;
      metadata = result.metadata;
    } catch (err) {
      logger.error({ err }, 'tape-reader.discover.failed');
    }
  }

  if (tokens.length === 0) {
    logger.warn(
      'tape-reader.no_tokens: nothing to track. Set TAPE_READER_TOKEN_IDS or check CLOB connectivity.',
    );
  }

  const restPoller =
    env.TAPE_READER_MODE === 'rest' || env.TAPE_READER_MODE === 'both'
      ? startRestPoller({
          httpUrl: env.POLYMARKET_CLOB_HTTP_URL,
          intervalMs: env.TAPE_READER_POLL_INTERVAL_MS,
          maxLevels: env.TAPE_READER_MAX_LEVELS,
          tokens,
          bus,
          logger,
        })
      : null;

  const wsClient =
    env.TAPE_READER_MODE === 'ws' || env.TAPE_READER_MODE === 'both'
      ? startClobWsClient({
          wsUrl: `${env.POLYMARKET_CLOB_WS_URL}/market`,
          tokens,
          maxLevels: env.TAPE_READER_MAX_LEVELS,
          bus,
          logger,
          customFeatureEnabled: env.TAPE_READER_WS_CUSTOM_FEATURE,
        })
      : null;

  if (restPoller) {
    await restPoller.start();
    logger.info('tape-reader.rest.started');
  }
  if (wsClient) {
    await wsClient.start();
    logger.info('tape-reader.ws.started');
  }

  const metadataPublisher = startMetadataPublisher({
    bus,
    logger,
    intervalMs: env.TAPE_READER_METADATA_INTERVAL_MS,
    metadata,
  });
  if (metadata.length > 0) {
    await metadataPublisher.start();
    logger.info(
      { count: metadata.length, intervalMs: env.TAPE_READER_METADATA_INTERVAL_MS },
      'tape-reader.metadata.publisher.started',
    );
  } else {
    logger.warn('tape-reader.metadata.publisher.skipped: no metadata to publish');
  }

  const health = await startHealthServer({
    botId: 'tape-reader',
    port: env.HEALTH_PORT_TAPE_READER,
    logger,
    details: () => ({
      tokensTracked: tokens.length,
      marketsTracked: metadata.length,
      mode: env.TAPE_READER_MODE,
      source: env.TAPE_READER_TOKEN_IDS ? 'manual' : 'auto',
      rest: restPoller ? restPoller.getStats() : null,
      ws: wsClient ? wsClient.getStats() : null,
      metadata: metadataPublisher.getStats(),
      sample: tokens.slice(0, 3).map((t) => ({
        marketId: t.marketId,
        outcome: t.outcome,
        slug: t.slug,
      })),
    }),
  });
  logger.info({ url: health.url }, 'bot-tape-reader.health.ready');

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'bot-tape-reader.shutdown');
    await metadataPublisher.stop();
    if (restPoller) await restPoller.stop();
    if (wsClient) await wsClient.stop();
    await bus.shutdown();
    await health.stop();
    process.exit(0);
  };
  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
};

main().catch((err: unknown) => {
  logger.fatal({ err }, 'bot-tape-reader.fatal');
  process.exit(1);
});
