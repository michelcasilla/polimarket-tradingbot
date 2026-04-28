import {
  Channels,
  type ExecutorStatusEvent,
  ExecutorStatusEventSchema,
} from '@polymarket-bot/contracts';
import type { GatewayEvent } from './types';

/**
 * Base URL for Panic / Resume / Cancel HTTP calls.
 *
 * - If `VITE_DASHBOARD_HTTP_URL` is set → use it (trim trailing slash).
 * - In Vite **development** with no override → empty string (same origin + relative
 *   `/control/...`). Vite proxies `/control` to the gateway (see vite.config.ts),
 *   so opening the app as `http://192.168.x.x:5173` still works.
 * - Production build without env → `http://localhost:7010` (set `VITE_DASHBOARD_HTTP_URL`
 *   at build time or put nginx in front of `/control`).
 */
const controlApiBase = (): string => {
  const raw = import.meta.env.VITE_DASHBOARD_HTTP_URL?.trim();
  if (raw) return raw.replace(/\/$/, '');
  if (import.meta.env.DEV) return '';
  return 'http://localhost:7010';
};

/** Parse executor status from a gateway LOG event (`source: redis`, `channel`, `data`). */
export const extractExecutorStatus = (event: GatewayEvent): ExecutorStatusEvent | null => {
  const channel = event.payload['channel'];
  if (channel !== Channels.systemExecutorStatus) return null;
  const data = event.payload['data'];
  const parsed = ExecutorStatusEventSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
};

const controlUrl = (path: string): string => {
  const base = controlApiBase();
  const p = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${p}` : p;
};

export const panicExecutor = (): Promise<Response> =>
  fetch(controlUrl('/control/executor/panic'), { method: 'POST' });

export const resumeExecutor = (): Promise<Response> =>
  fetch(controlUrl('/control/executor/resume'), { method: 'POST' });

export const cancelOrder = (orderId: string, marketId: string): Promise<Response> =>
  fetch(controlUrl(`/control/executor/orders/${encodeURIComponent(orderId)}/cancel`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketId }),
  });
