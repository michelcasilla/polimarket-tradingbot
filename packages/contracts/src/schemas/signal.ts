import { z } from 'zod';
import { OutcomeSchema } from './market.js';

export const StrategyReasonSchema = z.enum([
  'SPREAD_CAPTURE',
  'SUM_TO_ONE_ARBITRAGE',
  'NEWS_ARBITRAGE',
  'OPTIMISTIC_BIAS',
  'INVENTORY_REBALANCE',
  'MANUAL',
]);
export type StrategyReason = z.infer<typeof StrategyReasonSchema>;

export const MarketSignalSchema = z.object({
  marketId: z.string().min(1),
  outcome: OutcomeSchema,
  fairPrice: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reason: StrategyReasonSchema,
  ttlMs: z.number().int().positive(),
  timestamp: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()).optional(),
});
export type MarketSignal = z.infer<typeof MarketSignalSchema>;

export const OracleProviderSchema = z.enum([
  'BINANCE',
  'COINBASE',
  'SPORTRADAR',
  'NEWS_API',
  'TWITTER',
  'CUSTOM',
]);
export type OracleProvider = z.infer<typeof OracleProviderSchema>;

export const OracleEventTypeSchema = z.enum([
  'PRICE_DELTA',
  'SCORE_CHANGE',
  'BREAKING_NEWS',
  'SOCIAL_SENTIMENT',
  'CUSTOM',
]);
export type OracleEventType = z.infer<typeof OracleEventTypeSchema>;

export const OracleSignalSchema = z.object({
  id: z.string().min(1),
  provider: OracleProviderSchema,
  eventType: OracleEventTypeSchema,
  impactScore: z.number().min(0).max(1),
  topic: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  rawData: z.unknown(),
});
export type OracleSignal = z.infer<typeof OracleSignalSchema>;
