import { useMemo } from 'react';
import type { ExecutorStatusEvent } from '@polymarket-bot/contracts';
import type { GatewayEvent } from '../types';
import { extractExecutorStatus } from '../executorControl';

/**
 * Latest executor pause/resume snapshot from `system:executor-control` events.
 * `rareEvents` is newest-first (see useGatewaySocket).
 */
export const useExecutorStatus = (rareEvents: GatewayEvent[]): ExecutorStatusEvent | null =>
  useMemo(() => {
    for (const e of rareEvents) {
      const s = extractExecutorStatus(e);
      if (s) return s;
    }
    return null;
  }, [rareEvents]);
