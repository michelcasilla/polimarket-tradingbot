import { useEffect, useMemo, useRef, useState } from 'react';
import type { GatewayEvent } from './types';

const DEFAULT_WS_URL = 'ws://localhost:7010/ws';
const DEFAULT_BUFFER = 250;
const DEFAULT_RARE_BUFFER = 200;
const FLUSH_INTERVAL_MS = 200;
const RATE_WINDOW_MS = 1000;

/**
 * High-frequency channels — these can fire hundreds of times per second.
 * They go into the bounded "events" buffer (default 250).
 *
 * Anything NOT in this set is considered rare/important (oracle signals,
 * strategist signals, executor results, system events) and goes into a
 * SEPARATE buffer (`rareEvents`) so it cannot be evicted by book-update
 * floods. Without this split, a busy tape-reader silently buries every
 * oracle signal in <1s.
 */
const HIGH_FREQ_CHANNEL_PREFIXES = ['polymarket:book:'];

const isHighFrequencyEvent = (event: GatewayEvent): boolean => {
  const channel = event.payload['channel'];
  if (typeof channel !== 'string') return false;
  return HIGH_FREQ_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix));
};

export interface GatewaySocketState {
  status: 'connecting' | 'open' | 'closed' | 'error';
  /** All events (rare + high-freq) merged newest-first. Bounded by bufferLimit. */
  events: GatewayEvent[];
  /** Rare events only (signals, executor, system). Bounded by rareBufferLimit. */
  rareEvents: GatewayEvent[];
  wsUrl: string;
  eventsPerSecond: number;
  totalReceived: number;
  bufferLimit: number;
  rareBufferLimit: number;
  clearEvents: () => void;
}

interface UseGatewaySocketOptions {
  /** Maximum high-frequency events kept in memory. */
  bufferLimit?: number;
  /** Maximum rare events (signals, system) kept in memory. */
  rareBufferLimit?: number;
  /** Flush interval (ms). Higher = fewer renders, lower = more responsive. */
  flushIntervalMs?: number;
}

/**
 * WebSocket subscription with three production-grade affordances:
 *  1. **Batched flush** via `setInterval`: incoming WS messages accumulate in a
 *     ref and are pushed to React state at most every `flushIntervalMs`. This
 *     keeps the UI responsive even under bursty book-delta traffic.
 *  2. **Bounded buffer** via `bufferLimit` (default 250). Older events are
 *     evicted to keep memory and render time stable.
 *  3. **Throughput meter** (`eventsPerSecond`) for observability — useful to
 *     tell if the bus is chatty or quiet without staring at logs.
 */
export const useGatewaySocket = (
  options: UseGatewaySocketOptions = {},
): GatewaySocketState => {
  const bufferLimit = options.bufferLimit ?? DEFAULT_BUFFER;
  const rareBufferLimit = options.rareBufferLimit ?? DEFAULT_RARE_BUFFER;
  const flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;

  const [status, setStatus] = useState<GatewaySocketState['status']>('connecting');
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [rareEvents, setRareEvents] = useState<GatewayEvent[]>([]);
  const [eventsPerSecond, setEventsPerSecond] = useState(0);
  const [totalReceived, setTotalReceived] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<GatewayEvent[]>([]);
  const recentTimestampsRef = useRef<number[]>([]);

  const wsUrl = useMemo(() => {
    const envUrl = (import.meta as ImportMeta & { env?: Record<string, string> }).env
      ?.VITE_DASHBOARD_WS_URL;
    return envUrl || DEFAULT_WS_URL;
  }, []);

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setStatus('connecting');

    const enqueue = (event: GatewayEvent): void => {
      pendingRef.current.push(event);
      const now = performance.now();
      recentTimestampsRef.current.push(now);
    };

    ws.onopen = () => setStatus('open');

    ws.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data) as GatewayEvent;
        enqueue(parsed);
      } catch {
        enqueue({
          type: 'LOG',
          timestamp: Date.now(),
          payload: { raw: String(message.data), parseError: true },
        });
      }
    };

    ws.onerror = () => setStatus('error');
    ws.onclose = () => setStatus('closed');

    const flushTimer = window.setInterval(() => {
      const queued = pendingRef.current;
      if (queued.length > 0) {
        pendingRef.current = [];
        const reversed = [...queued].reverse();
        const rareInBatch = reversed.filter((evt) => !isHighFrequencyEvent(evt));

        setEvents((prev) => {
          const merged = [...reversed, ...prev];
          return merged.length > bufferLimit ? merged.slice(0, bufferLimit) : merged;
        });
        if (rareInBatch.length > 0) {
          setRareEvents((prev) => {
            const merged = [...rareInBatch, ...prev];
            return merged.length > rareBufferLimit ? merged.slice(0, rareBufferLimit) : merged;
          });
        }
        setTotalReceived((prev) => prev + queued.length);
      }
      const cutoff = performance.now() - RATE_WINDOW_MS;
      const recent = recentTimestampsRef.current.filter((t) => t >= cutoff);
      recentTimestampsRef.current = recent;
      setEventsPerSecond(recent.length);
    }, flushIntervalMs);

    return () => {
      window.clearInterval(flushTimer);
      ws.close();
      wsRef.current = null;
      pendingRef.current = [];
      recentTimestampsRef.current = [];
    };
  }, [wsUrl, bufferLimit, rareBufferLimit, flushIntervalMs]);

  const clearEvents = (): void => {
    setEvents([]);
    setRareEvents([]);
    setTotalReceived(0);
  };

  return {
    status,
    events,
    rareEvents,
    wsUrl,
    eventsPerSecond,
    totalReceived,
    bufferLimit,
    rareBufferLimit,
    clearEvents,
  };
};
