import type { OracleSignal } from '@polymarket-bot/contracts';
import type { Logger } from '@polymarket-bot/logger';

export interface PythProviderConfig {
  enabled: boolean;
  endpoint: string;
  symbols: string[];
  pollIntervalMs: number;
  minDeltaPct: number;
  logger: Logger;
  publishSignal: (signal: OracleSignal) => Promise<void>;
}

export interface PythProvider {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getStats: () => Record<string, unknown>;
}

export const createPythProvider = (cfg: PythProviderConfig): PythProvider => {
  let timer: NodeJS.Timeout | null = null;
  let polls = 0;
  let errors = 0;
  const lastBySymbol = new Map<string, number>();

  const poll = async (): Promise<void> => {
    for (const symbol of cfg.symbols) {
      try {
        const res = await fetch(`${cfg.endpoint}?ids[]=${encodeURIComponent(symbol)}`);
        if (!res.ok) continue;
        const json = (await res.json()) as { parsed?: Array<{ price?: { price?: string } }> };
        const px = Number(json.parsed?.[0]?.price?.price ?? NaN);
        if (!Number.isFinite(px) || px <= 0) continue;
        const prev = lastBySymbol.get(symbol);
        lastBySymbol.set(symbol, px);
        if (prev === undefined) continue;
        const deltaPct = ((px - prev) / prev) * 100;
        if (Math.abs(deltaPct) < cfg.minDeltaPct) continue;
        const impactScore = Math.min(Math.abs(deltaPct) / Math.max(cfg.minDeltaPct * 2, 0.1), 1);
        await cfg.publishSignal({
          id: `pyth-${symbol}-${Date.now()}`,
          provider: 'PYTH',
          eventType: 'PRICE_DELTA',
          impactScore,
          topic: symbol,
          timestamp: Date.now(),
          rawData: { symbol, prev, current: px, deltaPct },
        });
      } catch (err) {
        errors += 1;
        cfg.logger.warn({ err, symbol }, 'oracle.pyth.poll.failed');
      }
    }
    polls += 1;
  };

  return {
    start: async () => {
      if (!cfg.enabled || timer) return;
      await poll();
      timer = setInterval(() => void poll(), cfg.pollIntervalMs);
    },
    stop: async () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    getStats: () => ({
      enabled: cfg.enabled,
      polls,
      errors,
      symbols: cfg.symbols.length,
    }),
  };
};
