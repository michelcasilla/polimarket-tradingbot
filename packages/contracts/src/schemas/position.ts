import { z } from 'zod';
import { OutcomeSchema, SideSchema } from './market.js';

export const PositionSourceSchema = z.enum(['LOCAL', 'RECONCILED']);
export type PositionSource = z.infer<typeof PositionSourceSchema>;

export const PositionSchema = z.object({
  marketId: z.string().min(1),
  outcome: OutcomeSchema,
  netSize: z.number(),
  averageEntryPrice: z.number().min(0).max(1),
  realizedPnlUsdc: z.number(),
  unrealizedPnlUsdc: z.number(),
  lastFillAt: z.number().int().nonnegative().nullable(),
  source: PositionSourceSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type Position = z.infer<typeof PositionSchema>;

export const FillSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  signalId: z.string().optional(),
  marketId: z.string().min(1),
  outcome: OutcomeSchema,
  side: SideSchema,
  size: z.number().positive(),
  price: z.number().min(0).max(1),
  feesUsdc: z.number().nonnegative(),
  isMaker: z.boolean(),
  timestamp: z.number().int().nonnegative(),
});
export type Fill = z.infer<typeof FillSchema>;
