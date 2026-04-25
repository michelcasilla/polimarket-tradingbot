import {
  type ExecutionOrder,
  type ExecutionResult,
  type ExecutionStatus,
  type OrderBookSnapshot,
} from '@polymarket-bot/contracts';

/**
 * In-memory simulator that mirrors a thin Polymarket CLOB execution flow.
 *
 * Design constraints:
 *  - Deterministic enough to be testable but stochastic enough that PLACED
 *    orders don't fill instantly when the spread is wide.
 *  - Book cache is bounded (one snapshot per `marketId:outcome`).
 *  - Resting orders are bounded by `maxOpenOrders` to avoid memory blowup
 *    if an upstream loop misbehaves.
 *  - Risk envelope is enforced BEFORE accepting the order (notional cap +
 *    daily PnL stop). Once a stop fires the simulator stays "halted" until
 *    `resetCircuitBreaker()` is called.
 */

export interface SimulatorConfig {
  /** Per-order notional cap in USDC (price × size). */
  maxNotionalUsdc: number;
  /** Synthetic taker fee in basis points applied to immediate fills. */
  takerFeeBps: number;
  /** Synthetic maker fee in basis points applied to resting fills. */
  makerFeeBps: number;
  /** Daily realized loss limit. Triggers circuit breaker when exceeded. */
  dailyStopLossUsdc: number;
  /** Hard cap on simultaneously resting orders. */
  maxOpenOrders: number;
  /** Default TTL applied when ExecutionOrder.ttlMs is missing. */
  defaultTtlMs: number;
  /** Latency floor & jitter (ms) for the synthetic fill report. */
  latencyMinMs: number;
  latencyJitterMs: number;
}

export interface SimulatorStats {
  ordersReceived: number;
  ordersAccepted: number;
  ordersRejected: number;
  ordersFilled: number;
  ordersCancelled: number;
  ordersExpired: number;
  postOnlyRejections: number;
  notionalUsdc: number;
  feesUsdc: number;
  estimatedPnlUsdc: number;
  openOrders: number;
  bookCount: number;
  circuitBreakerActive: boolean;
}

interface RestingOrder {
  order: ExecutionOrder;
  acceptedAt: number;
  expiresAt: number;
}

const bookKey = (marketId: string, outcome: string): string => `${marketId}:${outcome}`;

const safeBest = (levels: { price: number; size: number }[] | undefined): number | null =>
  levels && levels.length > 0 ? levels[0]!.price : null;

const wouldCross = (order: ExecutionOrder, bestBid: number | null, bestAsk: number | null): boolean => {
  if (order.side === 'BUY') {
    return bestAsk !== null && order.price >= bestAsk;
  }
  return bestBid !== null && order.price <= bestBid;
};

const fillPrice = (order: ExecutionOrder, bestBid: number | null, bestAsk: number | null): number =>
  order.side === 'BUY' ? bestAsk ?? order.price : bestBid ?? order.price;

export const createSimulator = (config: SimulatorConfig) => {
  const books = new Map<string, OrderBookSnapshot>();
  const open = new Map<string, RestingOrder>();
  const stats: SimulatorStats = {
    ordersReceived: 0,
    ordersAccepted: 0,
    ordersRejected: 0,
    ordersFilled: 0,
    ordersCancelled: 0,
    ordersExpired: 0,
    postOnlyRejections: 0,
    notionalUsdc: 0,
    feesUsdc: 0,
    estimatedPnlUsdc: 0,
    openOrders: 0,
    bookCount: 0,
    circuitBreakerActive: false,
  };

  const upsertBook = (snapshot: OrderBookSnapshot): void => {
    books.set(bookKey(snapshot.marketId, snapshot.outcome), snapshot);
    stats.bookCount = books.size;
  };

  const getBest = (marketId: string, outcome: string): { bid: number | null; ask: number | null } => {
    const snap = books.get(bookKey(marketId, outcome));
    if (!snap) return { bid: null, ask: null };
    return { bid: safeBest(snap.bids), ask: safeBest(snap.asks) };
  };

  const buildResult = (
    order: ExecutionOrder,
    status: ExecutionStatus,
    extras: Partial<ExecutionResult> = {},
  ): ExecutionResult => ({
    orderId: order.id,
    marketId: order.marketId,
    status,
    filledSize: 0,
    timestamp: Date.now(),
    ...extras,
  });

  const synthLatencyMs = (): number =>
    config.latencyMinMs + Math.floor(Math.random() * Math.max(1, config.latencyJitterMs));

  const recordFill = (
    order: ExecutionOrder,
    avgPrice: number,
    feeBps: number,
  ): { fees: number; notional: number } => {
    const notional = avgPrice * order.size;
    const fees = (notional * feeBps) / 10_000;
    stats.ordersFilled += 1;
    stats.notionalUsdc += notional;
    stats.feesUsdc += fees;
    // Naive pessimistic PnL: every fill costs us the fee (we don't model the
    // round-trip, so this is just a bounded "money burned" metric so the
    // dashboard has something meaningful while the strategist is still WIP).
    stats.estimatedPnlUsdc -= fees;
    if (-stats.estimatedPnlUsdc >= config.dailyStopLossUsdc) {
      stats.circuitBreakerActive = true;
    }
    return { fees, notional };
  };

  /**
   * Receive an order and return the immediate ExecutionResult plus any
   * follow-up timer-driven results (PLACED-then-FILLED, EXPIRED).
   */
  const submit = (
    order: ExecutionOrder,
  ): { immediate: ExecutionResult; deferred?: { afterMs: number; result: ExecutionResult } } => {
    stats.ordersReceived += 1;

    if (stats.circuitBreakerActive) {
      stats.ordersRejected += 1;
      return {
        immediate: buildResult(order, 'REJECTED', {
          error: 'circuit_breaker_active',
        }),
      };
    }

    const notional = order.price * order.size;
    if (notional > config.maxNotionalUsdc) {
      stats.ordersRejected += 1;
      return {
        immediate: buildResult(order, 'REJECTED', {
          error: `notional_${notional.toFixed(2)}_exceeds_${config.maxNotionalUsdc}`,
        }),
      };
    }

    if (open.size >= config.maxOpenOrders) {
      stats.ordersRejected += 1;
      return {
        immediate: buildResult(order, 'REJECTED', {
          error: 'open_orders_cap',
        }),
      };
    }

    const { bid, ask } = getBest(order.marketId, order.outcome);
    if (bid === null && ask === null) {
      // No book yet: accept as resting until we have data or it expires.
      const expiresAt = Date.now() + (order.ttlMs ?? config.defaultTtlMs);
      open.set(order.id, { order, acceptedAt: Date.now(), expiresAt });
      stats.ordersAccepted += 1;
      stats.openOrders = open.size;
      return {
        immediate: buildResult(order, 'PLACED'),
      };
    }

    const crosses = wouldCross(order, bid, ask);

    if (crosses && order.postOnly) {
      stats.ordersRejected += 1;
      stats.postOnlyRejections += 1;
      return {
        immediate: buildResult(order, 'REJECTED', {
          error: 'post_only_would_cross',
        }),
      };
    }

    if (crosses) {
      const px = fillPrice(order, bid, ask);
      const { fees } = recordFill(order, px, config.takerFeeBps);
      stats.ordersAccepted += 1;
      const result = buildResult(order, 'FILLED', {
        filledSize: order.size,
        averagePrice: px,
        fees,
      });
      return {
        immediate: buildResult(order, 'PLACED'),
        deferred: { afterMs: synthLatencyMs(), result },
      };
    }

    const expiresAt = Date.now() + (order.ttlMs ?? config.defaultTtlMs);
    open.set(order.id, { order, acceptedAt: Date.now(), expiresAt });
    stats.ordersAccepted += 1;
    stats.openOrders = open.size;
    return {
      immediate: buildResult(order, 'PLACED'),
    };
  };

  /**
   * Cancel a resting order. Returns the ExecutionResult to broadcast, or null
   * when the orderId is unknown (already filled / expired / never existed).
   */
  const cancel = (orderId: string): ExecutionResult | null => {
    const resting = open.get(orderId);
    if (!resting) return null;
    open.delete(orderId);
    stats.openOrders = open.size;
    stats.ordersCancelled += 1;
    return buildResult(resting.order, 'CANCELLED');
  };

  /**
   * Sweep the resting book: fill anything the latest snapshot would now cross,
   * expire anything past its TTL. Called on every snapshot ingest + on a
   * periodic timer in case orders TTL out without new snapshots arriving.
   */
  const sweep = (now: number = Date.now()): ExecutionResult[] => {
    if (open.size === 0) return [];
    const out: ExecutionResult[] = [];
    for (const [orderId, resting] of Array.from(open.entries())) {
      const { order, expiresAt } = resting;
      if (now >= expiresAt) {
        open.delete(orderId);
        stats.openOrders = open.size;
        stats.ordersExpired += 1;
        out.push(buildResult(order, 'EXPIRED'));
        continue;
      }
      const { bid, ask } = getBest(order.marketId, order.outcome);
      if (bid === null && ask === null) continue;
      if (!wouldCross(order, bid, ask)) continue;
      // Resting order now crosses → maker-side fill.
      const px = fillPrice(order, bid, ask);
      const { fees } = recordFill(order, px, config.makerFeeBps);
      open.delete(orderId);
      stats.openOrders = open.size;
      out.push(
        buildResult(order, 'FILLED', {
          filledSize: order.size,
          averagePrice: px,
          fees,
        }),
      );
    }
    return out;
  };

  return {
    upsertBook,
    submit,
    cancel,
    sweep,
    getStats: (): SimulatorStats => ({ ...stats }),
    resetCircuitBreaker: (): void => {
      stats.circuitBreakerActive = false;
      stats.estimatedPnlUsdc = 0;
    },
    getOpenOrderIds: (): string[] => Array.from(open.keys()),
  };
};

export type Simulator = ReturnType<typeof createSimulator>;
