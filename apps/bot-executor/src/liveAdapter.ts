import {
  type CancelOrder,
  type ExecutionOrder,
  type ExecutionResult,
} from '@polymarket-bot/contracts';

/**
 * Placeholder for the real Polymarket CLOB on-chain executor.
 *
 * Why this stub exists today:
 *  - The simulator already exercises the full message contract.
 *  - We want `EXECUTOR_MODE=live` to be a real, distinguishable code path so
 *    misconfiguration is loud (it will refuse to launch without a usable
 *    private key) instead of silently falling back to simulation.
 *  - The actual signing flow (EIP-712 typed data → Polymarket CLOB POST) and
 *    nonce management is non-trivial and will land alongside Plan 5; until
 *    then every live order is acknowledged and immediately rejected so no
 *    real funds can move.
 */

export interface LiveAdapterConfig {
  privateKey: string;
  proxyWallet: string | undefined;
  rpcUrl: string;
  chainId: number;
  clobHttpUrl: string;
}

export interface LiveAdapterStats {
  ordersReceived: number;
  ordersRejected: number;
  cancelsReceived: number;
}

const REJECTION_REASON = 'live_mode_not_yet_implemented';

export const createLiveAdapter = (config: LiveAdapterConfig) => {
  // Touch fields once so config object isn't tree-shaken / unused.
  if (config.privateKey.length < 64) {
    throw new Error('liveAdapter: privateKey rejected (too short)');
  }

  const stats: LiveAdapterStats = {
    ordersReceived: 0,
    ordersRejected: 0,
    cancelsReceived: 0,
  };

  return {
    submit: (order: ExecutionOrder): ExecutionResult => {
      stats.ordersReceived += 1;
      stats.ordersRejected += 1;
      return {
        orderId: order.id,
        marketId: order.marketId,
        status: 'REJECTED',
        filledSize: 0,
        error: REJECTION_REASON,
        timestamp: Date.now(),
      };
    },

    cancel: (cancel: CancelOrder): ExecutionResult => {
      stats.cancelsReceived += 1;
      return {
        orderId: cancel.orderId,
        marketId: cancel.marketId,
        status: 'REJECTED',
        filledSize: 0,
        error: REJECTION_REASON,
        timestamp: Date.now(),
      };
    },

    getStats: (): LiveAdapterStats => ({ ...stats }),
    getDescriptor: () => ({
      mode: 'live' as const,
      chainId: config.chainId,
      clobHttpUrl: config.clobHttpUrl,
      hasProxyWallet: Boolean(config.proxyWallet),
    }),
  };
};

export type LiveAdapter = ReturnType<typeof createLiveAdapter>;
