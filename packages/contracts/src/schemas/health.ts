import { z } from 'zod';

export const BotIdSchema = z.enum([
  'oracle',
  'tape-reader',
  'strategist',
  'executor',
  'dashboard-gateway',
]);
export type BotId = z.infer<typeof BotIdSchema>;

export const HealthStatusSchema = z.enum(['UP', 'DEGRADED', 'DOWN']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const HealthReportSchema = z.object({
  botId: BotIdSchema,
  status: HealthStatusSchema,
  uptimeSec: z.number().nonnegative(),
  details: z.record(z.unknown()).optional(),
  timestamp: z.number().int().nonnegative(),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;

export const CircuitBreakerEventSchema = z.object({
  botId: BotIdSchema,
  reason: z.enum([
    'CONSECUTIVE_LOSSES',
    'INVENTORY_LIMIT',
    'GAS_LOW',
    'NETWORK_FAILURES',
    'MANUAL_KILL',
  ]),
  triggeredAt: z.number().int().nonnegative(),
  detail: z.string().optional(),
});
export type CircuitBreakerEvent = z.infer<typeof CircuitBreakerEventSchema>;
