import type { GatewayEvent } from './types';
import type { MarketSnapshot } from './market';

export type ExecutionStatus =
  | 'PENDING'
  | 'PLACED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'ERROR';

export type ExecutionSide = 'BUY' | 'SELL';
export type ExecutionOutcome = 'YES' | 'NO';

export type ExecutorRunMode = 'simulation' | 'live';

export interface ExecutionResultView {
  orderId: string;
  marketId: string;
  status: ExecutionStatus;
  filledSize: number;
  averagePrice: number | null;
  fees: number | null;
  error: string | null;
  timestamp: number;
  /** Order context echoed back by the executor (best-effort, may be null for legacy results). */
  outcome: ExecutionOutcome | null;
  side: ExecutionSide | null;
  requestedPrice: number | null;
  requestedSize: number | null;
  expiresAt: number | null;
  signalReason: string | null;
  /** From executor payload; null if legacy event without tag (treated as simulation when filtering). */
  executorMode: ExecutorRunMode | null;
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

const isSide = (value: unknown): value is ExecutionSide =>
  value === 'BUY' || value === 'SELL';

const isOutcome = (value: unknown): value is ExecutionOutcome =>
  value === 'YES' || value === 'NO';

const isExecutorMode = (value: unknown): value is ExecutorRunMode =>
  value === 'simulation' || value === 'live';

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Best-effort recovery of the strategist signal reason from the orderId, used
 * only when the executor didn't echo back `signalReason`. The strategist
 * autoexec format is `auto-{marketIdShort}-{OUTCOME}-{REASON}-{ts}`.
 */
const parseAutoexecReason = (orderId: string): string | null => {
  if (!orderId.startsWith('auto-')) return null;
  const parts = orderId.split('-');
  if (parts.length < 5) return null;
  // parts: ['auto', marketIdShort, OUTCOME, REASON..., ts]
  // REASON itself can contain '_' but never '-', so it's a single segment.
  return parts[3] ?? null;
};

export const extractExecutionResult = (event: GatewayEvent): ExecutionResultView | null => {
  if (!isExecutionChannel(event.payload['channel'])) return null;
  const data = event.payload['data'];
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d['orderId'] !== 'string' || typeof d['marketId'] !== 'string') return null;
  if (!isStatus(d['status'])) return null;

  const orderId = d['orderId'];
  const signalReason =
    typeof d['signalReason'] === 'string' ? d['signalReason'] : parseAutoexecReason(orderId);

  return {
    orderId,
    marketId: d['marketId'],
    status: d['status'],
    filledSize: typeof d['filledSize'] === 'number' ? d['filledSize'] : 0,
    averagePrice: num(d['averagePrice']),
    fees: num(d['fees']),
    error: typeof d['error'] === 'string' ? d['error'] : null,
    timestamp: typeof d['timestamp'] === 'number' ? d['timestamp'] : event.timestamp,
    outcome: isOutcome(d['outcome']) ? d['outcome'] : null,
    side: isSide(d['side']) ? d['side'] : null,
    requestedPrice: num(d['requestedPrice']),
    requestedSize: num(d['requestedSize']),
    expiresAt: num(d['expiresAt']),
    signalReason,
    executorMode: isExecutorMode(d['executorMode']) ? d['executorMode'] : null,
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

/**
 * Mark-to-market PnL for a single execution result.
 *
 * Treats every fill as an open position closed at the OPPOSING side of the
 * current top-of-book (BUY → close at bestBid, SELL → close at bestAsk),
 * minus reported fees. Returns null when:
 *   - the result has no fill (PLACED / EXPIRED / REJECTED / CANCELLED), or
 *   - we lack the snapshot needed to mark to market.
 */
export const computeLivePnlUsdc = (
  view: ExecutionResultView,
  snapshots: MarketSnapshot[],
): number | null => {
  if (view.filledSize <= 0 || view.averagePrice === null) return null;
  if (!view.side || !view.outcome) return null;

  const snap = snapshots.find(
    (s) => s.marketId === view.marketId && s.outcome === view.outcome,
  );
  let exitPrice: number | null = null;
  if (snap) {
    exitPrice = view.side === 'BUY' ? snap.bestBid : snap.bestAsk;
    if (exitPrice === null) exitPrice = snap.midPrice;
  }
  if (exitPrice === null) return null;

  const direction = view.side === 'BUY' ? 1 : -1;
  const grossPnl = direction * (exitPrice - view.averagePrice) * view.filledSize;
  const fees = view.fees ?? 0;
  return grossPnl - fees;
};
