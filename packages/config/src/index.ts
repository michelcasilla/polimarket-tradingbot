import { z } from 'zod';

const NodeEnv = z.enum(['development', 'test', 'staging', 'production']);
const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/**
 * Common environment variables shared by every bot. Each app extends this
 * with its own bot-specific schema.
 */
export const CommonEnvSchema = z.object({
  NODE_ENV: NodeEnv.default('development'),
  LOG_LEVEL: LogLevel.default('info'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  REDIS_NAMESPACE: z.string().default('polymarket'),
});
export type CommonEnv = z.infer<typeof CommonEnvSchema>;

export const PolymarketEnvSchema = z.object({
  POLYMARKET_CLOB_HTTP_URL: z.string().url().default('https://clob.polymarket.com'),
  POLYMARKET_CLOB_WS_URL: z.string().url().default('wss://ws-subscriptions-clob.polymarket.com/ws'),
  POLYMARKET_CHAIN_ID: z.coerce.number().int().positive().default(137),
});
export type PolymarketEnv = z.infer<typeof PolymarketEnvSchema>;

export const PolygonEnvSchema = z.object({
  POLYGON_RPC_URL: z.string().url().default('https://polygon-rpc.com'),
  // Length validation lives in the live adapter (bot-executor) so that
  // simulation/dev runs can boot with whatever placeholder is in `.env`.
  POLYGON_PRIVATE_KEY: z.string().optional(),
  POLYGON_PROXY_WALLET: z.string().optional(),
});
export type PolygonEnv = z.infer<typeof PolygonEnvSchema>;

export const RiskEnvSchema = z.object({
  MAX_CAPITAL_PER_TRADE_USDC: z.coerce.number().nonnegative().default(50),
  DAILY_STOP_LOSS_USDC: z.coerce.number().nonnegative().default(100),
  MAX_INVENTORY_PERCENT: z.coerce.number().min(0).max(100).default(10),
  MIN_GAS_BALANCE_MATIC: z.coerce.number().nonnegative().default(5),
});
export type RiskEnv = z.infer<typeof RiskEnvSchema>;

/**
 * Parse a record (e.g. `process.env`) against a zod schema. Throws an Error
 * with a human-readable summary when validation fails — fail fast at boot,
 * never run with broken config.
 */
export const loadEnv = <S extends z.ZodTypeAny>(
  schema: S,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): z.infer<S> => {
  const result = schema.safeParse(source);
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${summary}`);
  }
  return result.data;
};
