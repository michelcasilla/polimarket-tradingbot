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
  /**
   * Free-form tag identifying which strategy emitted the order
   * (e.g. SPREAD_CAPTURE). Echoed back in ExecutionResult so the dashboard
   * can label the row without parsing the orderId.
   */
  signalReason: z.string().optional(),
  ttlMs: z.number().int().positive().optional(),
  createdAt: z.number().int().nonnegative(),
});
export type ExecutionOrder = z.infer<typeof ExecutionOrderSchema>;

export const CancelOrderSchema = z.object({
  orderId: z.string().min(1),
  marketId: z.string().min(1),
  reason: z.enum([
    'STRATEGY',
    'CIRCUIT_BREAKER',
    'TTL',
    'MANUAL',
    'ORACLE_EVENT',
    /** Dashboard manual cancel via HTTP gateway */
    'DASHBOARD',
  ]),
  requestedAt: z.number().int().nonnegative(),
});
export type CancelOrder = z.infer<typeof CancelOrderSchema>;

export const ExecutorControlCommandSchema = z.object({
  type: z.enum(['PAUSE', 'RESUME']),
  reason: z.string().optional(),
  requestedAt: z.number().int().nonnegative(),
});
export type ExecutorControlCommand = z.infer<typeof ExecutorControlCommandSchema>;

export const ExecutorStatusEventSchema = z.object({
  paused: z.boolean(),
  /** Epoch-ms when current paused/resume state began. */
  since: z.number().int().nonnegative(),
  openOrderCount: z.number().int().min(0),
  mode: z.enum(['simulation', 'live']),
  lastReason: z.string().nullable(),
});
export type ExecutorStatusEvent = z.infer<typeof ExecutorStatusEventSchema>;

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
  /**
   * Order context echoed back by the executor so dashboards/strategists can
   * reconcile a result with the originating intent without keeping an
   * in-memory map. All optional for backward compat.
   */
  outcome: OutcomeSchema.optional(),
  side: SideSchema.optional(),
  requestedPrice: z.number().min(0).max(1).optional(),
  requestedSize: z.number().positive().optional(),
  /** Absolute epoch-ms when this PLACED order would TTL out. */
  expiresAt: z.number().int().nonnegative().optional(),
  /** Free-form reason tag (e.g. SPREAD_CAPTURE) so the UI can label results. */
  signalReason: z.string().optional(),
  /** Set by bot-executor when publishing so dashboards can filter simulation vs live. */
  executorMode: z.enum(['simulation', 'live']).optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
