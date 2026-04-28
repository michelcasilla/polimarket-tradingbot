import {
  type CancelOrder,
  type ExecutionOrder,
  type ExecutionResult,
} from '@polymarket-bot/contracts';
import { createRedis } from '@polymarket-bot/bus';
import { createPolymarketSigner } from './signer';

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
  proxyWallet: string;
  rpcUrl: string;
  chainId: number;
  clobHttpUrl: string;
  redisUrl: string;
  dryRun: boolean;
  signatureType: 0 | 1 | 2;
}

export interface LiveAdapterStats {
  initialized: boolean;
  ordersReceived: number;
  ordersPlaced: number;
  ordersRejected: number;
  cancelsReceived: number;
  cancelsSucceeded: number;
  apiKeyDerivations: number;
  apiErrors: number;
  dryRun: boolean;
}

const CREDS_KEY = 'polymarket:clob:creds';
const REJECTION_REASON = 'live_adapter_error';

export const createLiveAdapter = (config: LiveAdapterConfig) => {
  if (config.privateKey.length < 64) {
    throw new Error('liveAdapter: privateKey rejected (too short)');
  }

  const redis = createRedis({
    url: config.redisUrl,
    connectionName: 'bot-executor-live-creds',
  });
  const signer = createPolymarketSigner({
    privateKey: config.privateKey,
    proxyWallet: config.proxyWallet,
    signatureType: config.signatureType,
    chainId: config.chainId,
    host: config.clobHttpUrl,
    rpcUrl: config.rpcUrl,
    throwOnError: true,
  });

  const stats: LiveAdapterStats = {
    initialized: false,
    ordersReceived: 0,
    ordersPlaced: 0,
    ordersRejected: 0,
    cancelsReceived: 0,
    cancelsSucceeded: 0,
    apiKeyDerivations: 0,
    apiErrors: 0,
    dryRun: config.dryRun,
  };

  const createRejectedResult = (order: ExecutionOrder, reason: string): ExecutionResult => {
    const result: ExecutionResult = {
      orderId: order.id,
      marketId: order.marketId,
      status: 'REJECTED',
      filledSize: 0,
      error: reason,
      timestamp: Date.now(),
      outcome: order.outcome,
      side: order.side,
      requestedPrice: order.price,
      requestedSize: order.size,
    };
    if (order.signalReason) result.signalReason = order.signalReason;
    if (order.signalId) result.signalId = order.signalId;
    if (order.ttlMs) result.expiresAt = order.createdAt + order.ttlMs;
    return result;
  };

  return {
    init: async (): Promise<void> => {
      if (stats.initialized) return;
      await redis.connect();
      const raw = await redis.get(CREDS_KEY);
      const existing = raw ? (JSON.parse(raw) as { key: string; secret: string; passphrase: string }) : null;
      const client = signer.clobClient as unknown as {
        createOrDeriveApiKey: () => Promise<{ key: string; secret: string; passphrase: string }>;
      };
      if (!existing) {
        const creds = await client.createOrDeriveApiKey();
        stats.apiKeyDerivations += 1;
        await redis.set(CREDS_KEY, JSON.stringify(creds));
      }
      stats.initialized = true;
    },

    submit: async (order: ExecutionOrder): Promise<ExecutionResult> => {
      stats.ordersReceived += 1;
      if (!stats.initialized) {
        stats.ordersRejected += 1;
        return createRejectedResult(order, 'live_adapter_not_initialized');
      }
      if (config.dryRun) {
        stats.ordersPlaced += 1;
        const result: ExecutionResult = {
          orderId: order.id,
          marketId: order.marketId,
          status: 'PLACED',
          filledSize: 0,
          timestamp: Date.now(),
          outcome: order.outcome,
          side: order.side,
          requestedPrice: order.price,
          requestedSize: order.size,
          signalReason: order.signalReason,
          signalId: order.signalId,
        };
        return result;
      }
      try {
        const live = signer.clobClient as unknown as {
          createAndPostOrder: (
            orderArgs: { tokenID: string; side: 'BUY' | 'SELL'; price: number; size: number },
            marketArgs: { tickSize: string; negRisk?: boolean },
            tif: 'GTC' | 'IOC' | 'FOK',
          ) => Promise<{ orderID?: string; error?: string }>;
        };
        const resp = await live.createAndPostOrder(
          {
            tokenID: order.assetId,
            side: order.side,
            price: order.price,
            size: order.size,
          },
          { tickSize: '0.01', negRisk: false },
          order.timeInForce,
        );
        if (resp?.error) {
          stats.ordersRejected += 1;
          return createRejectedResult(order, String(resp.error));
        }
        stats.ordersPlaced += 1;
        return {
          orderId: resp?.orderID ?? order.id,
          marketId: order.marketId,
          status: 'PLACED',
          filledSize: 0,
          timestamp: Date.now(),
          outcome: order.outcome,
          side: order.side,
          requestedPrice: order.price,
          requestedSize: order.size,
          signalReason: order.signalReason,
          signalId: order.signalId,
        };
      } catch (err) {
        stats.apiErrors += 1;
        stats.ordersRejected += 1;
        const message = err instanceof Error ? err.message : REJECTION_REASON;
        return createRejectedResult(order, message);
      }
    },

    cancel: async (cancel: CancelOrder): Promise<ExecutionResult> => {
      stats.cancelsReceived += 1;
      if (!stats.initialized) {
        return {
          orderId: cancel.orderId,
          marketId: cancel.marketId,
          status: 'REJECTED',
          filledSize: 0,
          error: 'live_adapter_not_initialized',
          timestamp: Date.now(),
        };
      }
      if (config.dryRun) {
        stats.cancelsSucceeded += 1;
        return {
          orderId: cancel.orderId,
          marketId: cancel.marketId,
          status: 'CANCELLED',
          filledSize: 0,
          timestamp: Date.now(),
        };
      }
      try {
        const live = signer.clobClient as unknown as {
          cancelOrder: (args: { orderID: string }) => Promise<{ error?: string }>;
        };
        const resp = await live.cancelOrder({ orderID: cancel.orderId });
        if (resp?.error) {
          return {
            orderId: cancel.orderId,
            marketId: cancel.marketId,
            status: 'REJECTED',
            filledSize: 0,
            error: String(resp.error),
            timestamp: Date.now(),
          };
        }
        stats.cancelsSucceeded += 1;
        return {
          orderId: cancel.orderId,
          marketId: cancel.marketId,
          status: 'CANCELLED',
          filledSize: 0,
          timestamp: Date.now(),
        };
      } catch (err) {
        stats.apiErrors += 1;
        return {
          orderId: cancel.orderId,
          marketId: cancel.marketId,
          status: 'REJECTED',
          filledSize: 0,
          error: err instanceof Error ? err.message : REJECTION_REASON,
          timestamp: Date.now(),
        };
      }
    },

    shutdown: async (): Promise<void> => {
      if (redis.status !== 'end') await redis.quit();
    },

    getSignerAddress: (): string => signer.accountAddress,

    getFunderAddress: (): string => signer.funderAddress,

    getClobClient: () => signer.clobClient,

    getRedis: () => redis,

    isDryRun: () => config.dryRun,

    isInitialized: () => stats.initialized,

    getChainId: () => config.chainId,

    getHost: () => config.clobHttpUrl,

    getRpcUrl: () => config.rpcUrl,

    getSignatureType: () => config.signatureType,

    getProxyWallet: () => config.proxyWallet,

    getDescriptor: () => ({
      mode: 'live' as const,
      chainId: config.chainId,
      clobHttpUrl: config.clobHttpUrl,
      hasProxyWallet: Boolean(config.proxyWallet),
      dryRun: config.dryRun,
      initialized: stats.initialized,
      signerAddress: signer.accountAddress,
      funderAddress: signer.funderAddress,
      signatureType: config.signatureType,
    }),

    getStats: (): LiveAdapterStats => ({ ...stats }),
    createRejectedResult,
    createPlacedResult: (order: ExecutionOrder): ExecutionResult => ({
      orderId: order.id,
      marketId: order.marketId,
      status: 'PLACED',
      filledSize: 0,
      timestamp: Date.now(),
      outcome: order.outcome,
      side: order.side,
      requestedPrice: order.price,
      requestedSize: order.size,
      signalReason: order.signalReason,
      signalId: order.signalId,
    }),
    createCancelledResult: (cancel: CancelOrder): ExecutionResult => ({
      orderId: cancel.orderId,
      marketId: cancel.marketId,
      status: 'CANCELLED',
      filledSize: 0,
      timestamp: Date.now(),
    }),
    createRejectedCancelResult: (cancel: CancelOrder, reason: string): ExecutionResult => ({
      orderId: cancel.orderId,
      marketId: cancel.marketId,
      status: 'REJECTED',
      filledSize: 0,
      error: reason,
      timestamp: Date.now(),
    }),
    createErrorResult: (order: ExecutionOrder, reason: string): ExecutionResult => {
      return {
        orderId: order.id,
        marketId: order.marketId,
        status: 'ERROR',
        filledSize: 0,
        error: reason,
        timestamp: Date.now(),
        outcome: order.outcome,
        side: order.side,
        requestedPrice: order.price,
        requestedSize: order.size,
        signalReason: order.signalReason,
        signalId: order.signalId,
      };
    },
  };
};

export type LiveAdapter = ReturnType<typeof createLiveAdapter>;
