import { Redis, type RedisOptions } from 'ioredis';

export interface RedisFactoryOptions {
  url: string;
  namespace?: string;
  /** Connection name shown in `CLIENT LIST` for ops/debug. */
  connectionName?: string;
}

/**
 * Centralised Redis client factory. Always returns clients with:
 *  - exponential backoff reconnection
 *  - lazy connect (so process boot doesn't block on Redis)
 *  - no command queueing while offline (we want fast-fail, not silent buffering)
 */
export const createRedis = (opts: RedisFactoryOptions): Redis => {
  const config: RedisOptions = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 3,
    connectionName: opts.connectionName ?? 'polymarket-bot',
    retryStrategy(times) {
      const delay = Math.min(50 * 2 ** times, 2000);
      return delay;
    },
    reconnectOnError(err) {
      const target = 'READONLY';
      if (err.message.includes(target)) {
        return 2;
      }
      return 1;
    },
  };

  return new Redis(opts.url, config);
};
