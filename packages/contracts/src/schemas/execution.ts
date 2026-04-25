import { z } from 'zod';
import { SideSchema, OutcomeSchema } from './market.js';

export const OrderTypeSchema = z.enum(['LIMIT', 'MARKET']);
export type OrderType = z.infer<typeof OrderTypeSchema>;

export const TimeInForceSchema = z.enum(['GTC', 'IOC', 'FOK']);
export type TimeInForce = z.infer<typeof TimeInForceSchema>;

export const ExecutionOrderSchema = z.object({
  id: z.string().min(1),
  marketId: z.string().min(1),
  assetId: z.string().min(1),
  outcome: OutcomeSchema,
  side: SideSchema,
  price: z.number().min(0).max(1),
  size: z.number().positive(),
  type: OrderTypeSchema.default('LIMIT'),
  timeInForce: TimeInForceSchema.default('GTC'),
  /**
   * Crucial: Post-Only avoids becoming a Taker (high fees) and qualifies for Maker Rewards.
   * See section 3 of the architecture doc.
   */
  postOnly: z.boolean().default(true),
  signalId: z.string().optional(),
  ttlMs: z.number().int().positive().optional(),
  createdAt: z.number().int().nonnegative(),
});
export type ExecutionOrder = z.infer<typeof ExecutionOrderSchema>;

export const CancelOrderSchema = z.object({
  orderId: z.string().min(1),
  marketId: z.string().min(1),
  reason: z.enum(['STRATEGY', 'CIRCUIT_BREAKER', 'TTL', 'MANUAL', 'ORACLE_EVENT']),
  requestedAt: z.number().int().nonnegative(),
});
export type CancelOrder = z.infer<typeof CancelOrderSchema>;

export const ExecutionStatusSchema = z.enum([
  'PENDING',
  'PLACED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'ERROR',
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionResultSchema = z.object({
  orderId: z.string().min(1),
  marketId: z.string().min(1),
  status: ExecutionStatusSchema,
  filledSize: z.number().nonnegative().default(0),
  averagePrice: z.number().min(0).max(1).optional(),
  txHash: z.string().optional(),
  fees: z.number().nonnegative().optional(),
  error: z.string().optional(),
  timestamp: z.number().int().nonnegative(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
