import { Channels, type CircuitBreakerEvent, type ReconciliationEvent } from '@polymarket-bot/contracts';
import type { MessageBus } from '@polymarket-bot/bus';
import type { Logger } from '@polymarket-bot/logger';
import type { LiveAdapter } from './liveAdapter';

export interface ReconcilerConfig {
  intervalMs: number;
  bus: MessageBus;
  logger: Logger;
  liveAdapter: LiveAdapter;
  getLocalOpenOrderIds: () => string[];
  onRemoteTrade?: (trade: Record<string, unknown>) => Promise<void>;
}

export interface Reconciler {
  start: () => void;
  stop: () => void;
}

const listFromUnknown = (input: unknown): string[] => {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)['id'] === 'string') {
      out.push((item as Record<string, unknown>)['id'] as string);
    } else if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>)['orderID'] === 'string'
    ) {
      out.push((item as Record<string, unknown>)['orderID'] as string);
    }
  }
  return out;
};

export const createReconciler = (cfg: ReconcilerConfig): Reconciler => {
  let timer: NodeJS.Timeout | null = null;
  let failedPolls = 0;
  let lastTradeSyncAt = 0;

  const poll = async (): Promise<void> => {
    try {
      const clob = cfg.liveAdapter.getClobClient() as unknown as {
        getOpenOrders: () => Promise<unknown>;
        getTrades?: (args: { after: number }) => Promise<unknown>;
      };
      const remote = await clob.getOpenOrders();
      const remoteIds = new Set(listFromUnknown(remote));
      const localIds = new Set(cfg.getLocalOpenOrderIds());

      const missingLocalOrderIds = [...remoteIds].filter((id) => !localIds.has(id));
      const orphanLocalOrderIds = [...localIds].filter((id) => !remoteIds.has(id));

      const event: ReconciliationEvent = {
        checkedAt: Date.now(),
        openOrdersLocal: localIds.size,
        openOrdersRemote: remoteIds.size,
        missingLocalOrderIds,
        orphanLocalOrderIds,
        notes: [],
      };
      if (missingLocalOrderIds.length > 0 || orphanLocalOrderIds.length > 0) {
        event.notes.push('orderbook_drift_detected');
      }
      await cfg.bus.publish(Channels.executorReconciliation, event);

      if (clob.getTrades && cfg.onRemoteTrade) {
        const trades = await clob.getTrades({ after: lastTradeSyncAt });
        if (Array.isArray(trades)) {
          for (const trade of trades as Array<Record<string, unknown>>) {
            await cfg.onRemoteTrade(trade);
          }
        }
      }
      lastTradeSyncAt = Date.now();
      failedPolls = 0;
    } catch (err) {
      failedPolls += 1;
      cfg.logger.warn({ err, failedPolls }, 'executor.reconciler.poll.failed');
      if (failedPolls >= 3) {
        const event: CircuitBreakerEvent = {
          botId: 'executor',
          reason: 'NETWORK_FAILURES',
          triggeredAt: Date.now(),
          detail: 'reconciliation_failed',
        };
        await cfg.bus.publish(Channels.systemCircuitBreaker, event);
      }
    }
  };

  return {
    start: () => {
      if (timer) return;
      void poll();
      timer = setInterval(() => void poll(), cfg.intervalMs);
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
};
