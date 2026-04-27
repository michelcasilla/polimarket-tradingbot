import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchGammaMetadataForIds } from '../gammaClient';
import { buildSnapshotMap } from '../market';
import { buildSignalMap, isStale } from '../signals';
import { buildOracleMap } from '../oracle';
import { extractMetadata } from '../metadata';
import { buildExecutionList, computeLivePnlUsdc } from '../execution';
import { formatPnl } from '../formatting';
import type { GatewayEvent, UiMetric } from '../types';
import type { MarketMetadataView } from '../metadata';

export interface DashboardSocketMeta {
  status: 'connecting' | 'open' | 'closed' | 'error';
  eventsPerSecond: number;
  bufferLimit: number;
  totalReceived: number;
}

export const useDashboardAggregates = (
  events: GatewayEvent[],
  rareEvents: GatewayEvent[],
  now: number,
  socket: DashboardSocketMeta,
) => {
  const { status, eventsPerSecond, bufferLimit, totalReceived } = socket;

  const snapshots = useMemo(() => buildSnapshotMap(events), [events]);
  const signals = useMemo(() => buildSignalMap(rareEvents), [rareEvents]);
  const oracleSignals = useMemo(() => buildOracleMap(rareEvents), [rareEvents]);
  const executions = useMemo(() => buildExecutionList(rareEvents, 60), [rareEvents]);

  /**
   * Redis `polymarket:markets:metadata` events are rare and can fall off the bounded
   * `rareEvents` buffer. Keep a session map so labels stay stable once seen.
   */
  const redisMetadataAccRef = useRef(new Map<string, MarketMetadataView>());
  const redisMetadataMap = useMemo(() => {
    for (const event of rareEvents) {
      const meta = extractMetadata(event);
      if (!meta) continue;
      const prev = redisMetadataAccRef.current.get(meta.marketId);
      if (!prev || meta.receivedAt >= prev.receivedAt) {
        redisMetadataAccRef.current.set(meta.marketId, meta);
      }
    }
    return new Map(redisMetadataAccRef.current);
  }, [rareEvents]);

  const gammaRef = useRef(new Map<string, MarketMetadataView>());
  const [gammaMetadataMap, setGammaMetadataMap] = useState(() => new Map<string, MarketMetadataView>());
  gammaRef.current = gammaMetadataMap;

  const watchedMarketIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of snapshots) ids.add(s.marketId);
    for (const e of executions) ids.add(e.marketId);
    return [...ids].sort().join('\n');
  }, [snapshots, executions]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void (async () => {
        const ids = new Set<string>();
        for (const s of snapshots) ids.add(s.marketId);
        for (const e of executions) ids.add(e.marketId);
        const withoutRedis = [...ids].filter((id) => !redisMetadataAccRef.current.has(id));
        const needFetch = withoutRedis.filter((id) => !gammaRef.current.has(id));
        if (needFetch.length === 0) return;
        const fetched = await fetchGammaMetadataForIds(needFetch);
        setGammaMetadataMap((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const id of needFetch) {
            const row = fetched.get(id);
            if (row) {
              next.set(id, row);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      })();
    }, 120);
    return () => window.clearTimeout(handle);
  }, [watchedMarketIds, rareEvents, snapshots, executions]);

  const metadataMap = useMemo(() => {
    const merged = new Map(gammaMetadataMap);
    for (const [k, v] of redisMetadataMap) {
      // Redis is the freshest source overall, but it currently does NOT carry
      // `eventSlug` (the tape-reader publishes from /sampling-markets which
      // does not expose it). Keep the gamma-derived `eventSlug` so the
      // "view market" link keeps working after redis overrides the row.
      const prior = merged.get(k);
      const eventSlug = v.eventSlug ?? prior?.eventSlug ?? null;
      merged.set(k, { ...v, eventSlug });
    }
    return merged;
  }, [redisMetadataMap, gammaMetadataMap]);

  const fillCount = useMemo(
    () => executions.filter((e) => e.status === 'FILLED').length,
    [executions],
  );

  const tradeOutcomes = useMemo(() => {
    let wins = 0;
    let losses = 0;
    for (const exec of executions) {
      const pnl = computeLivePnlUsdc(exec, snapshots);
      if (pnl === null) continue;
      if (pnl > 0) wins += 1;
      else if (pnl < 0) losses += 1;
    }
    return { wins, losses };
  }, [executions, snapshots]);

  const livePnlUsdc = useMemo(() => {
    let sum = 0;
    let counted = 0;
    for (const exec of executions) {
      const pnl = computeLivePnlUsdc(exec, snapshots);
      if (pnl !== null) {
        sum += pnl;
        counted += 1;
      }
    }
    return { sum, counted };
  }, [executions, snapshots]);

  const liveSignals = useMemo(() => signals.filter((sig) => !isStale(sig, now)), [signals, now]);

  const metrics = useMemo<UiMetric[]>(() => {
    const healthEvents = events.filter((event) => event.type === 'HEALTH').length;
    const marketEvents = events.filter((event) => {
      const channel = event.payload['channel'];
      return typeof channel === 'string' && channel.startsWith('polymarket:book:');
    }).length;
    return [
      { key: 'connection', label: 'Connection', value: status.toUpperCase() },
      { key: 'rate', label: 'Events / sec', value: String(eventsPerSecond) },
      { key: 'markets', label: 'Tracked Markets', value: String(snapshots.length) },
      { key: 'live-signals', label: 'Live Signals', value: String(liveSignals.length) },
      { key: 'oracle-topics', label: 'Oracle Topics', value: String(oracleSignals.length) },
      { key: 'executions', label: 'Fills (recent)', value: String(fillCount) },
      {
        key: 'pnl',
        label: 'PnL (mtm, recent)',
        value:
          livePnlUsdc.counted === 0
            ? '—'
            : `${formatPnl(livePnlUsdc.sum)} (${livePnlUsdc.counted})`,
      },
      { key: 'market-events', label: 'Book Updates', value: String(marketEvents) },
      {
        key: 'buffer',
        label: 'Buffered / Limit',
        value: `${events.length} / ${bufferLimit}`,
      },
      { key: 'total', label: 'Total Received', value: String(totalReceived) },
      { key: 'health', label: 'Health Events', value: String(healthEvents) },
    ];
  }, [
    bufferLimit,
    events,
    eventsPerSecond,
    fillCount,
    livePnlUsdc.counted,
    livePnlUsdc.sum,
    liveSignals.length,
    oracleSignals.length,
    snapshots.length,
    status,
    totalReceived,
  ]);

  return {
    snapshots,
    signals,
    oracleSignals,
    metadataMap,
    executions,
    fillCount,
    tradeOutcomes,
    livePnlUsdc,
    liveSignals,
    metrics,
  };
};
