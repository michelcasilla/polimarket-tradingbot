import type { z } from 'zod';
import {
  MarketMetadataSchema,
  OrderBookDeltaSchema,
  OrderBookSnapshotSchema,
} from './schemas/market.js';
import { MarketSignalSchema, OracleSignalSchema } from './schemas/signal.js';
import {
  ExecutionOrderSchema,
  ExecutionResultSchema,
  CancelOrderSchema,
  ExecutorControlCommandSchema,
  ExecutorStatusEventSchema,
} from './schemas/execution.js';
import { FillSchema, PositionSchema } from './schemas/position.js';
import {
  AdverseSelectionEventSchema,
  MakerRewardScoreSchema,
  ReconciliationEventSchema,
} from './schemas/rewards.js';
import { HealthReportSchema, CircuitBreakerEventSchema } from './schemas/health.js';

/**
 * Static channel descriptors. Use the helpers below for parameterised channels
 * (e.g. one channel per marketId).
 *
 * Producers / Consumers (see Plans 2-6):
 *   polymarket:book:snapshot:*  -> Tape Reader  -> Strategist
 *   polymarket:book:delta:*     -> Tape Reader  -> Strategist
 *   polymarket:markets:metadata -> Tape Reader  -> Dashboard
 *   oracle:signals              -> Oracle       -> Strategist
 *   strategist:signals          -> Strategist   -> (logging / dashboard)
 *   executor:orders             -> Strategist   -> Executor
 *   executor:cancels            -> Strategist   -> Executor
 *   executor:results            -> Executor     -> Strategist + Dashboard
 *   executor:control            -> Dashboard GW -> Executor (pause/resume)
 *   system:executor-control     -> Executor     -> Dashboard Gateway
 *   system:health               -> all bots     -> Dashboard Gateway
 *   system:circuit-breaker      -> Strategist/Executor -> all bots
 */
export const Channels = {
  marketsMetadata: 'polymarket:markets:metadata',
  oracleSignals: 'oracle:signals',
  strategistSignals: 'strategist:signals',
  executorOrders: 'executor:orders',
  executorCancels: 'executor:cancels',
  executorResults: 'executor:results',
  executorPositions: 'executor:positions',
  executorFills: 'executor:fills',
  executorReconciliation: 'executor:reconciliation',
  executorControl: 'executor:control',
  strategistRewardScores: 'strategist:reward-scores',
  executorAdverseSelection: 'executor:adverse-selection',
  systemExecutorStatus: 'system:executor-control',
  systemHealth: 'system:health',
  systemCircuitBreaker: 'system:circuit-breaker',
} as const;

export type ChannelName =
  | (typeof Channels)[keyof typeof Channels]
  | `polymarket:book:snapshot:${string}`
  | `polymarket:book:delta:${string}`;

export const bookSnapshotChannel = (marketId: string): ChannelName =>
  `polymarket:book:snapshot:${marketId}` as const;

export const bookDeltaChannel = (marketId: string): ChannelName =>
  `polymarket:book:delta:${marketId}` as const;

export const bookSnapshotPattern = 'polymarket:book:snapshot:*' as const;
export const bookDeltaPattern = 'polymarket:book:delta:*' as const;

/**
 * Mapping from channel descriptor to its zod schema. The bus (`packages/bus`)
 * uses this map to validate every message at the boundary.
 */
export const ChannelSchemas = {
  [Channels.marketsMetadata]: MarketMetadataSchema,
  [Channels.oracleSignals]: OracleSignalSchema,
  [Channels.strategistSignals]: MarketSignalSchema,
  [Channels.executorOrders]: ExecutionOrderSchema,
  [Channels.executorCancels]: CancelOrderSchema,
  [Channels.executorResults]: ExecutionResultSchema,
  [Channels.executorPositions]: PositionSchema,
  [Channels.executorFills]: FillSchema,
  [Channels.executorReconciliation]: ReconciliationEventSchema,
  [Channels.executorControl]: ExecutorControlCommandSchema,
  [Channels.strategistRewardScores]: MakerRewardScoreSchema,
  [Channels.executorAdverseSelection]: AdverseSelectionEventSchema,
  [Channels.systemExecutorStatus]: ExecutorStatusEventSchema,
  [Channels.systemHealth]: HealthReportSchema,
  [Channels.systemCircuitBreaker]: CircuitBreakerEventSchema,
} as const;

export type StaticChannelName = keyof typeof ChannelSchemas;

export const PatternSchemas = {
  [bookSnapshotPattern]: OrderBookSnapshotSchema,
  [bookDeltaPattern]: OrderBookDeltaSchema,
} as const;

export type PatternName = keyof typeof PatternSchemas;

/**
 * Type-level lookup: given a channel name, return its payload type.
 */
export type PayloadOf<C extends StaticChannelName> = z.infer<(typeof ChannelSchemas)[C]>;

export type PayloadOfPattern<P extends PatternName> = z.infer<(typeof PatternSchemas)[P]>;
