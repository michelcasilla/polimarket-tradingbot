import { z } from 'zod';

export const SideSchema = z.enum(['BUY', 'SELL']);
export type Side = z.infer<typeof SideSchema>;

export const OutcomeSchema = z.enum(['YES', 'NO']);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const PriceLevelSchema = z.object({
  price: z.number().min(0).max(1),
  size: z.number().nonnegative(),
});
export type PriceLevel = z.infer<typeof PriceLevelSchema>;

export const OrderBookSnapshotSchema = z.object({
  marketId: z.string().min(1),
  assetId: z.string().min(1),
  outcome: OutcomeSchema,
  bids: z.array(PriceLevelSchema),
  asks: z.array(PriceLevelSchema),
  midPrice: z.number().min(0).max(1).nullable(),
  spread: z.number().nonnegative().nullable(),
  timestamp: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
});
export type OrderBookSnapshot = z.infer<typeof OrderBookSnapshotSchema>;

export const OrderBookDeltaSchema = z.object({
  marketId: z.string().min(1),
  assetId: z.string().min(1),
  outcome: OutcomeSchema,
  changes: z.array(
    z.object({
      side: z.enum(['bid', 'ask']),
      price: z.number().min(0).max(1),
      size: z.number().nonnegative(),
    }),
  ),
  timestamp: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
});
export type OrderBookDelta = z.infer<typeof OrderBookDeltaSchema>;

export const MarketMetadataSchema = z.object({
  marketId: z.string().min(1),
  question: z.string(),
  slug: z.string(),
  // Event-level slug (used to build polymarket.com/event/<slug> URLs).
  // The market `slug` alone often does NOT resolve on the website when the
  // market is part of a multi-outcome event, so the event slug is required
  // to build a working link.
  eventSlug: z.string().optional(),
  category: z.string().optional(),
  endDateIso: z.string().datetime().optional(),
  active: z.boolean(),
  closed: z.boolean(),
  volume24h: z.number().nonnegative().optional(),
  liquidity: z.number().nonnegative().optional(),
});
export type MarketMetadata = z.infer<typeof MarketMetadataSchema>;
