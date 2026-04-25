import type { GatewayEvent } from './types';

export type ExecutionStatus =
  | 'PENDING'
  | 'PLACED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'ERROR';

export interface ExecutionResultView {
  orderId: string;
  marketId: string;
  status: ExecutionStatus;
  filledSize: number;
  averagePrice: number | null;
  fees: number | null;
  error: string | null;
  timestamp: number;
}

const CHANNEL = 'executor:results';

const isExecutionChannel = (channel: unknown): channel is string =>
  typeof channel === 'string' && channel === CHANNEL;

const STATUSES: ExecutionStatus[] = [
  'PENDING',
  'PLACED',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
  'ERROR',
];

const isStatus = (value: unknown): value is ExecutionStatus =>
  typeof value === 'string' && (STATUSES as string[]).includes(value);

export const extractExecutionResult = (event: GatewayEvent): ExecutionResultView | null => {
  if (!isExecutionChannel(event.payload['channel'])) return null;
  const data = event.payload['data'];
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d['orderId'] !== 'string' || typeof d['marketId'] !== 'string') return null;
  if (!isStatus(d['status'])) return null;

  return {
    orderId: d['orderId'],
    marketId: d['marketId'],
    status: d['status'],
    filledSize: typeof d['filledSize'] === 'number' ? d['filledSize'] : 0,
    averagePrice: typeof d['averagePrice'] === 'number' ? d['averagePrice'] : null,
    fees: typeof d['fees'] === 'number' ? d['fees'] : null,
    error: typeof d['error'] === 'string' ? d['error'] : null,
    timestamp: typeof d['timestamp'] === 'number' ? d['timestamp'] : event.timestamp,
  };
};

/**
 * Newest-first list of the last N execution results from the rare-events
 * buffer. We keep PER-RESULT entries (not per-order) because a single order
 * legitimately produces multiple results (PLACED → FILLED, PLACED → EXPIRED).
 */
export const buildExecutionList = (
  events: GatewayEvent[],
  limit = 50,
): ExecutionResultView[] => {
  const out: ExecutionResultView[] = [];
  for (const event of events) {
    const view = extractExecutionResult(event);
    if (view) out.push(view);
    if (out.length >= limit) break;
  }
  return out;
};
