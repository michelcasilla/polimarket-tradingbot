import type { ZodTypeAny, z } from 'zod';
import {
  ChannelSchemas,
  PatternSchemas,
  type ChannelName,
  type StaticChannelName,
  type PatternName,
  type PayloadOf,
  type PayloadOfPattern,
  bookSnapshotPattern,
  bookDeltaPattern,
} from '@polymarket-bot/contracts';
import type { Logger } from '@polymarket-bot/logger';
import { createRedis, type RedisFactoryOptions } from './redisFactory.js';

export type Unsubscribe = () => Promise<void>;

export interface MessageBus {
  /** Publish a payload to a static channel. Validates against its zod schema. */
  publish<C extends StaticChannelName>(channel: C, payload: PayloadOf<C>): Promise<number>;

  /**
   * Publish to a parameterised channel (e.g. `polymarket:book:snapshot:<marketId>`).
   * The schema is resolved by matching the channel against a known pattern.
   */
  publishToPattern<P extends PatternName>(
    pattern: P,
    fullChannel: ChannelName,
    payload: PayloadOfPattern<P>,
  ): Promise<number>;

  /** Subscribe to a single channel. Returns an unsubscribe handle. */
  subscribe<C extends StaticChannelName>(
    channel: C,
    handler: (payload: PayloadOf<C>) => void | Promise<void>,
  ): Promise<Unsubscribe>;

  /** Pattern subscription (psubscribe). Used for `polymarket:book:*` etc. */
  psubscribe<P extends PatternName>(
    pattern: P,
    handler: (channel: ChannelName, payload: PayloadOfPattern<P>) => void | Promise<void>,
  ): Promise<Unsubscribe>;

  shutdown(): Promise<void>;
}

interface BusDeps {
  redis: RedisFactoryOptions;
  logger: Logger;
}

export const createBus = (deps: BusDeps): MessageBus => {
  const { logger } = deps;
  const publisher = createRedis({
    ...deps.redis,
    connectionName: `${deps.redis.connectionName ?? 'bus'}-pub`,
  });
  const subscriber = createRedis({
    ...deps.redis,
    connectionName: `${deps.redis.connectionName ?? 'bus'}-sub`,
  });

  const channelHandlers = new Map<string, Set<(raw: string) => void>>();
  const patternHandlers = new Map<string, Set<(channel: string, raw: string) => void>>();

  subscriber.on('message', (channel, raw) => {
    const handlers = channelHandlers.get(channel);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(raw);
      } catch (err) {
        logger.error({ err, channel }, 'bus.handler.error');
      }
    }
  });

  subscriber.on('pmessage', (pattern, channel, raw) => {
    const handlers = patternHandlers.get(pattern);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(channel, raw);
      } catch (err) {
        logger.error({ err, pattern, channel }, 'bus.phandler.error');
      }
    }
  });

  publisher.on('error', (err) => logger.error({ err }, 'bus.publisher.error'));
  subscriber.on('error', (err) => logger.error({ err }, 'bus.subscriber.error'));
  publisher.on('reconnecting', () => logger.warn('bus.publisher.reconnecting'));
  subscriber.on('reconnecting', () => logger.warn('bus.subscriber.reconnecting'));

  const ensureConnected = async (): Promise<void> => {
    if (publisher.status === 'wait' || publisher.status === 'end') {
      await publisher.connect().catch((err: unknown) => {
        logger.error({ err }, 'bus.publisher.connect.failed');
        throw err;
      });
    }
    if (subscriber.status === 'wait' || subscriber.status === 'end') {
      await subscriber.connect().catch((err: unknown) => {
        logger.error({ err }, 'bus.subscriber.connect.failed');
        throw err;
      });
    }
  };

  const validateAndStringify = <S extends ZodTypeAny>(
    schema: S,
    payload: unknown,
    channel: string,
  ): string => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      logger.error({ channel, issues: parsed.error.issues }, 'bus.publish.invalid_payload');
      throw new Error(`Invalid payload for channel ${channel}: ${parsed.error.message}`);
    }
    return JSON.stringify(parsed.data);
  };

  return {
    async publish(channel, payload) {
      await ensureConnected();
      const schema = ChannelSchemas[channel];
      const json = validateAndStringify(schema, payload, channel);
      return publisher.publish(channel, json);
    },

    async publishToPattern(pattern, fullChannel, payload) {
      await ensureConnected();
      const schema = PatternSchemas[pattern];
      const json = validateAndStringify(schema, payload, fullChannel);
      return publisher.publish(fullChannel, json);
    },

    async subscribe(channel, handler) {
      await ensureConnected();
      const schema = ChannelSchemas[channel] as unknown as z.ZodSchema;
      const wrapped = (raw: string): void => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch (err) {
          logger.error({ err, channel, raw }, 'bus.subscribe.invalid_json');
          return;
        }
        const result = schema.safeParse(parsedJson);
        if (!result.success) {
          logger.error({ channel, issues: result.error.issues }, 'bus.subscribe.invalid_payload');
          return;
        }
        const out = handler(result.data as PayloadOf<typeof channel>);
        if (out instanceof Promise) {
          out.catch((err: unknown) =>
            logger.error({ err, channel }, 'bus.subscribe.handler.rejected'),
          );
        }
      };

      const set = channelHandlers.get(channel) ?? new Set();
      const isFirst = set.size === 0;
      set.add(wrapped);
      channelHandlers.set(channel, set);
      if (isFirst) {
        await subscriber.subscribe(channel);
      }

      return async () => {
        const current = channelHandlers.get(channel);
        if (!current) return;
        current.delete(wrapped);
        if (current.size === 0) {
          channelHandlers.delete(channel);
          await subscriber.unsubscribe(channel);
        }
      };
    },

    async psubscribe(pattern, handler) {
      await ensureConnected();
      const schema = PatternSchemas[pattern] as unknown as z.ZodSchema;
      const wrapped = (channel: string, raw: string): void => {
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch (err) {
          logger.error({ err, pattern, channel }, 'bus.psubscribe.invalid_json');
          return;
        }
        const result = schema.safeParse(parsedJson);
        if (!result.success) {
          logger.error(
            { pattern, channel, issues: result.error.issues },
            'bus.psubscribe.invalid_payload',
          );
          return;
        }
        const out = handler(
          channel as ChannelName,
          result.data as PayloadOfPattern<typeof pattern>,
        );
        if (out instanceof Promise) {
          out.catch((err: unknown) =>
            logger.error({ err, pattern, channel }, 'bus.psubscribe.handler.rejected'),
          );
        }
      };

      const set = patternHandlers.get(pattern) ?? new Set();
      const isFirst = set.size === 0;
      set.add(wrapped);
      patternHandlers.set(pattern, set);
      if (isFirst) {
        await subscriber.psubscribe(pattern);
      }

      return async () => {
        const current = patternHandlers.get(pattern);
        if (!current) return;
        current.delete(wrapped);
        if (current.size === 0) {
          patternHandlers.delete(pattern);
          await subscriber.punsubscribe(pattern);
        }
      };
    },

    async shutdown() {
      channelHandlers.clear();
      patternHandlers.clear();
      await Promise.allSettled([subscriber.quit(), publisher.quit()]);
    },
  };
};

export { bookSnapshotPattern, bookDeltaPattern };
