import { createRedis } from '@polymarket-bot/bus';

export interface OrderLedgerConfig {
  redisUrl: string;
  redisKey?: string;
}

export interface OpenOrderRecord {
  orderId: string;
  marketId: string;
  createdAt: number;
  source: 'LOCAL' | 'REMOTE';
}

const defaultKey = 'polymarket:executor:open-orders';

export const createOrderLedger = (cfg: OrderLedgerConfig) => {
  const redis = createRedis({
    url: cfg.redisUrl,
    connectionName: 'bot-executor-open-orders',
  });
  const key = cfg.redisKey ?? defaultKey;
  const local = new Map<string, OpenOrderRecord>();

  const ensureRedis = async (): Promise<boolean> => {
    try {
      if (redis.status === 'wait') await redis.connect();
      return true;
    } catch {
      return false;
    }
  };

  const persist = async (record: OpenOrderRecord): Promise<void> => {
    if (!(await ensureRedis())) return;
    await redis.hset(key, record.orderId, JSON.stringify(record)).catch(() => undefined);
  };

  const remove = async (orderId: string): Promise<void> => {
    if (!(await ensureRedis())) return;
    await redis.hdel(key, orderId).catch(() => undefined);
  };

  return {
    load: async (): Promise<OpenOrderRecord[]> => {
      const ok = await ensureRedis();
      if (!ok) return Array.from(local.values());
      const all = await redis.hgetall(key).catch(() => ({} as Record<string, string>));
      for (const [orderId, raw] of Object.entries(all)) {
        try {
          const parsed = JSON.parse(raw) as OpenOrderRecord;
          local.set(orderId, parsed);
        } catch {
          // ignore malformed old rows
        }
      }
      return Array.from(local.values());
    },

    markPlaced: async (orderId: string, marketId: string, source: 'LOCAL' | 'REMOTE' = 'LOCAL') => {
      const record: OpenOrderRecord = {
        orderId,
        marketId,
        createdAt: Date.now(),
        source,
      };
      local.set(orderId, record);
      await persist(record);
    },

    markClosed: async (orderId: string) => {
      local.delete(orderId);
      await remove(orderId);
    },

    getOpenOrderIds: (): string[] => Array.from(local.keys()),

    mergeRemote: async (remoteOrderIds: string[]) => {
      for (const id of remoteOrderIds) {
        if (!local.has(id)) {
          await (async () => {
            const record: OpenOrderRecord = {
              orderId: id,
              marketId: 'unknown',
              createdAt: Date.now(),
              source: 'REMOTE',
            };
            local.set(id, record);
            await persist(record);
          })();
        }
      }
    },

    shutdown: async () => {
      if (redis.status !== 'end') await redis.quit().catch(() => undefined);
    },
  };
};

export type OrderLedger = ReturnType<typeof createOrderLedger>;
