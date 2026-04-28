import { z } from 'zod';
import { OutcomeSchema, SideSchema } from './market.js';

export const MakerRewardScoreSchema = z.object({
  marketId: z.string().min(1),
  outcome: OutcomeSchema,
  expectedScore: z.number().nonnegative(),
  vMaxSpread: z.number().nonnegative(),
  sActualSpread: z.number().nonnegative(),
  size: z.number().nonnegative(),
  twoSided: z.boolean(),
  computedAt: z.number().int().nonnegative(),
});
export type MakerRewardScore = z.infer<typeof MakerRewardScoreSchema>;

export const AdverseSelectionEventSchema = z.object({
  fillId: z.string().min(1),
  signalId: z.string().optional(),
  marketId: z.string().min(1),
  outcome: OutcomeSchema,
  side: SideSchema,
  fillPrice: z.number().min(0).max(1),
  midAtFill: z.number().min(0).max(1),
  midAtTPlus: z.number().min(0).max(1),
  horizonMs: z.number().int().positive(),
  wrongSide: z.boolean(),
  signedDriftBps: z.number(),
  computedAt: z.number().int().nonnegative(),
});
export type AdverseSelectionEvent = z.infer<typeof AdverseSelectionEventSchema>;

export const ReconciliationEventSchema = z.object({
  checkedAt: z.number().int().nonnegative(),
  openOrdersLocal: z.number().int().nonnegative(),
  openOrdersRemote: z.number().int().nonnegative(),
  missingLocalOrderIds: z.array(z.string()),
  orphanLocalOrderIds: z.array(z.string()),
  notes: z.array(z.string()).default([]),
});
export type ReconciliationEvent = z.infer<typeof ReconciliationEventSchema>;
