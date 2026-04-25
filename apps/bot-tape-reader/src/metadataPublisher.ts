import { Channels, type MarketMetadata } from '@polymarket-bot/contracts';
import type { MessageBus } from '@polymarket-bot/bus';
import type { Logger } from '@polymarket-bot/logger';

/**
 * Periodically broadcasts `MarketMetadata` for every tracked market to the
 * `polymarket:markets:metadata` channel so any consumer (dashboard, future
 * analytics) can render human-readable labels (question, slug, category,
 * end date) instead of raw conditionIds.
 *
 * Strategy:
 *  - Publishes once on `start()` and then again every `intervalMs`.
 *  - One Redis PUBLISH per market keeps each message tiny and lets the bus
 *    validate each payload independently.
 *  - On hot-reload of the metadata list (future: when discovery refreshes
 *    auto-detected markets) call `setMetadata()` and the next tick publishes
 *    the new set.
 */

export interface MetadataPublisherOptions {
  bus: MessageBus;
  logger: Logger;
  intervalMs: number;
  metadata: MarketMetadata[];
}

export interface MetadataPublisherStats {
  publishCycles: number;
  lastPublishAt: number | null;
  publishErrors: number;
  metadataCount: number;
}

export const startMetadataPublisher = (opts: MetadataPublisherOptions) => {
  let metadata = opts.metadata.slice();
  const stats: MetadataPublisherStats = {
    publishCycles: 0,
    lastPublishAt: null,
    publishErrors: 0,
    metadataCount: metadata.length,
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const publishOnce = async (): Promise<void> => {
    if (metadata.length === 0) return;
    let ok = 0;
    for (const meta of metadata) {
      try {
        await opts.bus.publish(Channels.marketsMetadata, meta);
        ok += 1;
      } catch (err) {
        stats.publishErrors += 1;
        opts.logger.warn(
          { err, marketId: meta.marketId },
          'tape-reader.metadata.publish.failed',
        );
      }
    }
    stats.publishCycles += 1;
    stats.lastPublishAt = Date.now();
    opts.logger.info(
      { count: ok, total: metadata.length, cycle: stats.publishCycles },
      'tape-reader.metadata.published',
    );
  };

  return {
    start: async (): Promise<void> => {
      stopped = false;
      await publishOnce();
      timer = setInterval(() => {
        if (stopped) return;
        publishOnce().catch((err: unknown) =>
          opts.logger.error({ err }, 'tape-reader.metadata.publish.cycle.failed'),
        );
      }, opts.intervalMs);
    },
    stop: async (): Promise<void> => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    setMetadata: (next: MarketMetadata[]): void => {
      metadata = next.slice();
      stats.metadataCount = metadata.length;
    },
    getStats: (): MetadataPublisherStats => ({ ...stats }),
  };
};
