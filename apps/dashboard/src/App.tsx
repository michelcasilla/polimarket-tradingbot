import {
  Badge,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Input,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { useGatewaySocket } from './useGatewaySocket';
import { useLocalStorage } from './useLocalStorage';
import type { GatewayEvent, UiMetric } from './types';
import {
  buildSnapshotMap,
  formatProb,
  formatSize,
  formatSpread,
  truncateId,
  type MarketSnapshot,
} from './market';
import {
  buildSignalMap,
  isStale,
  liveEdgeBps,
  type StrategistSignal,
} from './signals';
import { buildOracleMap, type OracleSignalView } from './oracle';
import { buildMetadataMap, type MarketMetadataView } from './metadata';
import {
  buildExecutionList,
  computeLivePnlUsdc,
  type ExecutionResultView,
  type ExecutionStatus,
} from './execution';

const { Title, Text } = Typography;

const connectionColor = {
  connecting: 'processing',
  open: 'success',
  closed: 'default',
  error: 'error',
} as const;

const SCOPE_VALUES = ['all', 'health', 'system', 'redis', 'markets'] as const;
type StreamScope = (typeof SCOPE_VALUES)[number];
const isStreamScope = (value: unknown): value is StreamScope =>
  typeof value === 'string' && (SCOPE_VALUES as readonly string[]).includes(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const getChannelFromEvent = (event: GatewayEvent): string => {
  const maybeChannel = event.payload['channel'];
  return typeof maybeChannel === 'string' ? maybeChannel : 'local';
};

const getStreamScopeFromEvent = (event: GatewayEvent): StreamScope => {
  if (event.type === 'HEALTH') return 'health';
  if (event.type === 'SYSTEM') return 'system';
  const channel = event.payload['channel'];
  if (typeof channel === 'string' && channel.startsWith('polymarket:book:')) return 'markets';
  if (event.payload['source'] === 'redis') return 'redis';
  return 'all';
};

const eventColumns: ColumnsType<GatewayEvent> = [
  {
    title: 'Type',
    dataIndex: 'type',
    key: 'type',
    width: 110,
    render: (value: GatewayEvent['type']) => (
      <Tag color={value === 'HEALTH' ? 'green' : value === 'SYSTEM' ? 'blue' : 'purple'}>
        {value}
      </Tag>
    ),
  },
  {
    title: 'Channel',
    key: 'channel',
    width: 320,
    render: (_: unknown, record: GatewayEvent) => (
      <Tag color="geekblue" className="mono">
        {getChannelFromEvent(record)}
      </Tag>
    ),
  },
  {
    title: 'Timestamp',
    dataIndex: 'timestamp',
    key: 'timestamp',
    width: 140,
    render: (value: number) => <span className="mono">{new Date(value).toLocaleTimeString()}</span>,
  },
  {
    title: 'Payload',
    dataIndex: 'payload',
    key: 'payload',
    render: (payload: Record<string, unknown>) => {
      const text = JSON.stringify(payload);
      const trimmed = text.length > 240 ? `${text.slice(0, 240)}…` : text;
      return (
        <Tooltip title={<pre style={{ margin: 0 }}>{JSON.stringify(payload, null, 2)}</pre>}>
          <span className="mono" style={{ whiteSpace: 'nowrap' }}>
            {trimmed}
          </span>
        </Tooltip>
      );
    },
  },
];

const reasonColors: Record<string, string> = {
  SPREAD_CAPTURE: 'gold',
  SUM_TO_ONE_ARBITRAGE: 'magenta',
  NEWS_ARBITRAGE: 'cyan',
  OPTIMISTIC_BIAS: 'lime',
  INVENTORY_REBALANCE: 'orange',
  MANUAL: 'default',
};

const buildSignalColumns = (
  snapshots: MarketSnapshot[],
  now: number,
): ColumnsType<StrategistSignal> => [
    {
      title: 'Market',
      key: 'marketId',
      render: (_: unknown, record) => (
        <Tooltip title={record.marketId}>
          <Tag className="mono" color="geekblue">
            {truncateId(record.marketId)}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: 'Outcome',
      key: 'outcome',
      width: 90,
      render: (_: unknown, record) => (
        <Tag color={record.outcome === 'YES' ? 'green' : 'volcano'}>{record.outcome}</Tag>
      ),
    },
    {
      title: 'Reason',
      key: 'reason',
      width: 200,
      render: (_: unknown, record) => (
        <Space size={4} direction="vertical" style={{ rowGap: 2 }}>
          <Tag color={reasonColors[record.reason] ?? 'default'}>{record.reason}</Tag>
          {record.direction && (
            <Text type="secondary" className="mono" style={{ fontSize: 11 }}>
              {record.direction}
            </Text>
          )}
        </Space>
      ),
    },
    {
      title: 'Fair',
      key: 'fairPrice',
      align: 'right',
      width: 90,
      render: (_: unknown, record) => <span className="mono">{formatProb(record.fairPrice)}</span>,
    },
    {
      title: 'Edge (bps)',
      key: 'edge',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => {
        const bps = liveEdgeBps(record, snapshots);
        if (bps === null) return <span className="mono">—</span>;
        const text = `${bps > 0 ? '+' : ''}${bps.toFixed(0)}`;
        if (bps > 0) {
          return (
            <Text type="success" className="mono">
              {text}
            </Text>
          );
        }
        if (bps < 0) {
          return (
            <Text type="danger" className="mono">
              {text}
            </Text>
          );
        }
        return <span className="mono">{text}</span>;
      },
    },
    {
      title: 'Confidence',
      key: 'confidence',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => (
        <span className="mono">{(record.confidence * 100).toFixed(0)}%</span>
      ),
    },
    {
      title: 'Spread',
      key: 'spread',
      align: 'right',
      width: 100,
      render: (_: unknown, record) => <span className="mono">{formatSpread(record.spread)}</span>,
    },
    {
      title: 'Age',
      key: 'age',
      align: 'right',
      width: 100,
      render: (_: unknown, record) => {
        const ageMs = now - record.timestamp;
        const stale = isStale(record, now);
        const text = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;
        if (stale) {
          return (
            <Text type="secondary" className="mono">
              {text} (stale)
            </Text>
          );
        }
        return <span className="mono">{text}</span>;
      },
    },
  ];

const providerColors: Record<string, string> = {
  BINANCE: 'gold',
  COINBASE: 'blue',
  SPORTRADAR: 'green',
  NEWS_API: 'magenta',
  TWITTER: 'cyan',
  CUSTOM: 'default',
};

const buildOracleColumns = (now: number): ColumnsType<OracleSignalView> => [
  {
    title: 'Topic',
    key: 'topic',
    render: (_: unknown, record) => (
      <Tag color="purple" className="mono">
        {record.topic}
      </Tag>
    ),
  },
  {
    title: 'Provider',
    key: 'provider',
    width: 120,
    render: (_: unknown, record) => (
      <Tag color={providerColors[record.provider] ?? 'default'}>{record.provider}</Tag>
    ),
  },
  {
    title: 'Event',
    key: 'eventType',
    width: 140,
    render: (_: unknown, record) => (
      <span className="mono" style={{ fontSize: 12 }}>
        {record.eventType}
      </span>
    ),
  },
  {
    title: 'Δ (1m)',
    key: 'delta',
    align: 'right',
    width: 110,
    render: (_: unknown, record) => {
      const raw = record.raw;
      const delta = typeof raw['deltaPct'] === 'number' ? (raw['deltaPct'] as number) : null;
      if (delta === null) return <span className="mono">—</span>;
      const text = `${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`;
      if (delta > 0) {
        return (
          <Text type="success" className="mono">
            {text}
          </Text>
        );
      }
      if (delta < 0) {
        return (
          <Text type="danger" className="mono">
            {text}
          </Text>
        );
      }
      return <span className="mono">{text}</span>;
    },
  },
  {
    title: 'Last Px',
    key: 'lastPrice',
    align: 'right',
    width: 130,
    render: (_: unknown, record) => {
      const raw = record.raw;
      const px = typeof raw['windowEndPrice'] === 'number'
        ? (raw['windowEndPrice'] as number)
        : null;
      if (px === null) return <span className="mono">—</span>;
      return (
        <span className="mono">
          {px >= 1000 ? px.toFixed(2) : px >= 1 ? px.toFixed(4) : px.toFixed(6)}
        </span>
      );
    },
  },
  {
    title: 'Impact',
    key: 'impactScore',
    align: 'right',
    width: 100,
    render: (_: unknown, record) => (
      <span className="mono">{(record.impactScore * 100).toFixed(0)}%</span>
    ),
  },
  {
    title: 'Age',
    key: 'age',
    align: 'right',
    width: 90,
    render: (_: unknown, record) => {
      const ageMs = now - record.timestamp;
      const text = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;
      return <span className="mono">{text}</span>;
    },
  },
];

const executionStatusColors: Record<ExecutionStatus, string> = {
  PENDING: 'default',
  PLACED: 'blue',
  PARTIALLY_FILLED: 'gold',
  FILLED: 'green',
  CANCELLED: 'orange',
  REJECTED: 'red',
  EXPIRED: 'purple',
  ERROR: 'magenta',
};

const formatDurationMs = (ms: number): string => {
  if (!Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (abs < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
};

const formatPnl = (value: number | null): string => {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const magnitude = Math.abs(value);
  if (magnitude < 0.0001) return '$0.0000';
  return `${sign}$${magnitude.toFixed(4)}`;
};

const buildExecutionColumns = (
  metadataMap: Map<string, MarketMetadataView>,
  snapshots: MarketSnapshot[],
  now: number,
): ColumnsType<ExecutionResultView> => [
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2} style={{ rowGap: 0 }}>
          <Tag color={executionStatusColors[record.status]}>{record.status}</Tag>
          {record.side && (
            <Tag
              color={record.side === 'BUY' ? 'green' : 'volcano'}
              style={{ fontSize: 10, lineHeight: '14px', padding: '0 4px' }}
            >
              {record.side}
              {record.outcome ? ` ${record.outcome}` : ''}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Order',
      key: 'orderId',
      width: 170,
      render: (_: unknown, record) => (
        <Space direction="vertical" size={2} style={{ rowGap: 0 }}>
          <Tooltip title={record.orderId}>
            <span className="mono" style={{ fontSize: 11 }}>
              {truncateId(record.orderId, 8, 6)}
            </span>
          </Tooltip>
          {record.signalReason && (
            <Tag color="blue" style={{ fontSize: 10, lineHeight: '14px', padding: '0 4px' }}>
              {record.signalReason}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Market',
      key: 'marketId',
      render: (_: unknown, record) => {
        const meta = metadataMap.get(record.marketId);
        return (
          <Space direction="vertical" size={2} style={{ rowGap: 0 }}>
            <Tooltip title={meta?.question ?? record.marketId}>
              <Text style={{ display: 'block', maxWidth: 320 }} ellipsis>
                {meta?.question ?? truncateId(record.marketId)}
              </Text>
            </Tooltip>
            <Tag className="mono" color="geekblue">
              {truncateId(record.marketId)}
            </Tag>
          </Space>
        );
      },
    },
    {
      title: 'Filled',
      key: 'filledSize',
      align: 'right',
      width: 120,
      render: (_: unknown, record) => {
        const requested = record.requestedSize;
        if (requested === null && record.filledSize === 0) {
          return <span className="mono">—</span>;
        }
        const filled = record.filledSize.toFixed(2);
        const total = requested === null ? '?' : requested.toFixed(2);
        const fullyFilled = requested !== null && record.filledSize >= requested;
        return (
          <Tooltip title={`${filled} filled out of ${total} requested`}>
            <span
              className="mono"
              style={{
                color:
                  record.filledSize === 0 ? 'rgba(255,255,255,0.45)' : fullyFilled ? '#52c41a' : '#faad14',
              }}
            >
              {filled} / {total}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Avg Px',
      key: 'avg',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => {
        if (record.averagePrice !== null) {
          return <span className="mono">{formatProb(record.averagePrice)}</span>;
        }
        if (record.requestedPrice !== null) {
          return (
            <Tooltip title="Limit price (no fill)">
              <span className="mono" style={{ color: 'rgba(255,255,255,0.45)' }}>
                @{formatProb(record.requestedPrice)}
              </span>
            </Tooltip>
          );
        }
        return <span className="mono">—</span>;
      },
    },
    {
      title: 'Fees',
      key: 'fees',
      align: 'right',
      width: 90,
      render: (_: unknown, record) => {
        const value = record.fees ?? 0;
        const muted = record.filledSize === 0;
        return (
          <span className="mono" style={{ color: muted ? 'rgba(255,255,255,0.45)' : undefined }}>
            ${value.toFixed(4)}
          </span>
        );
      },
    },
    {
      title: 'PnL (mtm)',
      key: 'pnl',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => {
        const pnl = computeLivePnlUsdc(record, snapshots);
        if (pnl === null) {
          return <span className="mono" style={{ color: 'rgba(255,255,255,0.35)' }}>—</span>;
        }
        const color = pnl > 0 ? '#52c41a' : pnl < 0 ? '#ff4d4f' : undefined;
        return (
          <Tooltip title="Mark-to-market: (close@bestBid for BUY / bestAsk for SELL) − filled price − fees">
            <span className="mono" style={{ color, fontWeight: 600 }}>
              {formatPnl(pnl)}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Reason',
      key: 'reason',
      width: 180,
      render: (_: unknown, record) => {
        if (record.error) {
          return (
            <Text type="danger" className="mono" style={{ fontSize: 11 }}>
              {record.error}
            </Text>
          );
        }
        if (record.signalReason) {
          return (
            <Text type="secondary" style={{ fontSize: 11 }}>
              {record.signalReason}
            </Text>
          );
        }
        return <span className="mono">—</span>;
      },
    },
    {
      title: 'Age / TTL',
      key: 'age',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => {
        const ageMs = now - record.timestamp;
        const ageText = formatDurationMs(ageMs);
        if (record.status === 'PLACED' && record.expiresAt !== null) {
          const remaining = record.expiresAt - now;
          if (remaining > 0) {
            return (
              <Space direction="vertical" size={0} style={{ rowGap: 0 }}>
                <span className="mono" style={{ color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>
                  {ageText}
                </span>
                <Tooltip title="Time until TTL expiry">
                  <span
                    className="mono"
                    style={{
                      color: remaining < 1000 ? '#ff4d4f' : remaining < 3000 ? '#faad14' : '#52c41a',
                      fontWeight: 600,
                    }}
                  >
                    ⏳ {formatDurationMs(remaining)}
                  </span>
                </Tooltip>
              </Space>
            );
          }
        }
        return <span className="mono">{ageText}</span>;
      },
    },
  ];

const formatVolume = (value: number | null): string => {
  if (value === null) return '—';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
};

const buildMarketColumns = (
  metadataMap: Map<string, MarketMetadataView>,
): ColumnsType<MarketSnapshot> => [
    {
      title: 'Market',
      key: 'marketId',
      width: 360,
      render: (_: unknown, record) => {
        const meta = metadataMap.get(record.marketId);
        return (
          <Space direction="vertical" size={2} style={{ rowGap: 0 }}>
            <Tooltip title={meta?.question ?? record.marketId}>
              <Text strong style={{ display: 'block', maxWidth: 340 }} ellipsis>
                {meta?.question ?? `(awaiting metadata) ${truncateId(record.marketId)}`}
              </Text>
            </Tooltip>
            <Space size={4} wrap>
              {meta?.category && <Tag color="purple">{meta.category}</Tag>}
              {meta?.slug && (
                <Text type="secondary" className="mono" style={{ fontSize: 11 }}>
                  {meta.slug}
                </Text>
              )}
              <Tooltip title={record.marketId}>
                <Tag className="mono" color="geekblue">
                  {truncateId(record.marketId)}
                </Tag>
              </Tooltip>
            </Space>
          </Space>
        );
      },
    },
    {
      title: 'Outcome',
      key: 'outcome',
      width: 90,
      render: (_: unknown, record) => (
        <Tag color={record.outcome === 'YES' ? 'green' : 'volcano'}>{record.outcome}</Tag>
      ),
    },
    {
      title: 'Mid',
      key: 'mid',
      align: 'right',
      width: 90,
      render: (_: unknown, record) => <span className="mono">{formatProb(record.midPrice)}</span>,
    },
    {
      title: 'Best Bid',
      key: 'bestBid',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => <span className="mono">{formatProb(record.bestBid)}</span>,
    },
    {
      title: 'Best Ask',
      key: 'bestAsk',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => <span className="mono">{formatProb(record.bestAsk)}</span>,
    },
    {
      title: 'Spread',
      key: 'spread',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => <span className="mono">{formatSpread(record.spread)}</span>,
    },
    {
      title: 'Bid Depth',
      key: 'bidDepth',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => <span className="mono">{formatSize(record.bidDepth)}</span>,
    },
    {
      title: 'Ask Depth',
      key: 'askDepth',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => <span className="mono">{formatSize(record.askDepth)}</span>,
    },
    {
      title: 'Vol 24h',
      key: 'volume24h',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => {
        const meta = metadataMap.get(record.marketId);
        return <span className="mono">{formatVolume(meta?.volume24h ?? null)}</span>;
      },
    },
    {
      title: 'Updated',
      key: 'timestamp',
      align: 'right',
      width: 110,
      render: (_: unknown, record) => (
        <span className="mono">{new Date(record.timestamp).toLocaleTimeString()}</span>
      ),
    },
  ];

const App = () => {
  const {
    status,
    events,
    rareEvents,
    wsUrl,
    eventsPerSecond,
    totalReceived,
    bufferLimit,
    clearEvents,
  } = useGatewaySocket();
  const [scope, setScope] = useLocalStorage<StreamScope>('dash.scope', 'all', isStreamScope);
  const [channelFilter, setChannelFilter] = useLocalStorage<string>(
    'dash.channelFilter',
    'all',
    isString,
  );
  const [search, setSearch] = useLocalStorage<string>('dash.search', '', isString);

  const snapshots = useMemo(() => buildSnapshotMap(events), [events]);
  const signals = useMemo(() => buildSignalMap(rareEvents), [rareEvents]);
  const oracleSignals = useMemo(() => buildOracleMap(rareEvents), [rareEvents]);
  const metadataMap = useMemo(() => buildMetadataMap(rareEvents), [rareEvents]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);

  const signalColumns = useMemo(() => buildSignalColumns(snapshots, now), [snapshots, now]);
  const oracleColumns = useMemo(() => buildOracleColumns(now), [now]);
  const marketColumns = useMemo(() => buildMarketColumns(metadataMap), [metadataMap]);
  const executions = useMemo(() => buildExecutionList(rareEvents, 60), [rareEvents]);
  const executionColumns = useMemo(
    () => buildExecutionColumns(metadataMap, snapshots, now),
    [metadataMap, snapshots, now],
  );
  const fillCount = useMemo(
    () => executions.filter((e) => e.status === 'FILLED').length,
    [executions],
  );
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
  const liveSignals = useMemo(
    () => signals.filter((sig) => !isStale(sig, now)),
    [signals, now],
  );

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
    snapshots,
    status,
    totalReceived,
  ]);

  const channelOptions = useMemo(() => {
    const values = new Set<string>(['all']);
    for (const event of events) {
      values.add(getChannelFromEvent(event));
    }
    return Array.from(values);
  }, [events]);

  const filteredEvents = useMemo(() => {
    let next = events;

    if (scope !== 'all') {
      next = next.filter((event) => getStreamScopeFromEvent(event) === scope);
    }

    if (channelFilter !== 'all') {
      next = next.filter((event) => getChannelFromEvent(event) === channelFilter);
    }

    const needle = search.trim().toLowerCase();
    if (needle.length > 0) {
      next = next.filter((event) => {
        const hay = JSON.stringify(event).toLowerCase();
        return hay.includes(needle);
      });
    }

    return next;
  }, [events, scope, channelFilter, search]);

  const resetFilters = (): void => {
    setScope('all');
    setChannelFilter('all');
    setSearch('');
  };

  return (
    <div className="dashboard-shell">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card>
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Title level={3} style={{ margin: 0 }}>
              Polymarket HFT Dashboard
            </Title>
            <Text type="secondary">
              Real-time monitor connected to <span className="mono">dashboard-gateway</span>.
            </Text>
            <Space size={16} wrap>
              <Badge status={connectionColor[status]} text={`Socket: ${status}`} />
              <Text className="mono">{wsUrl}</Text>
              <Button size="small" onClick={clearEvents}>
                Clear events
              </Button>
              <Button size="small" onClick={resetFilters}>
                Reset filters
              </Button>
            </Space>
          </Space>
        </Card>

        <Row gutter={[16, 16]}>
          {metrics.map((metric) => (
            <Col key={metric.key} flex={1}>
              <Card>
                <Statistic title={metric.label} value={metric.value} />
              </Card>
            </Col>
          ))}
        </Row>

        <Card
          title="Top Markets (Polymarket CLOB)"
          extra={
            <Text type="secondary">
              {snapshots.length === 0
                ? 'Waiting for first snapshot…'
                : `${snapshots.length} markets · ${metadataMap.size} with metadata · live from bot-tape-reader`}
            </Text>
          }
        >
          {snapshots.length === 0 ? (
            <Empty description="No order book snapshots received yet. Verify that bot-tape-reader is healthy." />
          ) : (
            <Table
              rowKey={(record) => `${record.marketId}-${record.outcome}`}
              columns={marketColumns}
              dataSource={snapshots}
              pagination={false}
              scroll={{ x: 1300, y: 420 }}
              size="small"
              virtual
            />
          )}
        </Card>

        <Card
          title="Strategist Signals"
          extra={
            <Text type="secondary">
              {liveSignals.length === 0
                ? signals.length === 0
                  ? 'Waiting for first signal…'
                  : `${signals.length} historical (all stale)`
                : `${liveSignals.length} live · ${signals.length} total in buffer`}
            </Text>
          }
        >
          {signals.length === 0 ? (
            <Empty description="No strategist signals received yet. Check bot-strategist health." />
          ) : (
            <Table
              rowKey={(record) =>
                `${record.marketId}-${record.outcome}-${record.reason}-${record.direction ?? ''}`
              }
              columns={signalColumns}
              dataSource={signals}
              pagination={false}
              scroll={{ x: 1100, y: 320 }}
              size="small"
              virtual
              rowClassName={(record) => (isStale(record, now) ? 'row-stale' : '')}
            />
          )}
        </Card>

        <Card
          title="Oracle Signals (External feeds)"
          extra={
            <Text type="secondary">
              {oracleSignals.length === 0
                ? 'Waiting for first oracle signal…'
                : `${oracleSignals.length} topics tracked · live from bot-oracle`}
            </Text>
          }
        >
          {oracleSignals.length === 0 ? (
            <Empty description="No oracle signals yet. Confirm bot-oracle is connected to Binance." />
          ) : (
            <Table
              rowKey={(record) => record.topic}
              columns={oracleColumns}
              dataSource={oracleSignals}
              pagination={false}
              scroll={{ x: 1000, y: 280 }}
              size="small"
              virtual
            />
          )}
        </Card>

        <Card
          title="Execution Results (bot-executor)"
          extra={
            <Text type="secondary">
              {executions.length === 0
                ? 'Waiting for first execution result…'
                : livePnlUsdc.counted === 0
                  ? `${fillCount} fills · ${executions.length} recent results`
                  : `${fillCount} fills · PnL ${formatPnl(livePnlUsdc.sum)} (${livePnlUsdc.counted} marked) · ${executions.length} recent`}
            </Text>
          }
        >
          {executions.length === 0 ? (
            <Empty description="No execution results yet. Publish an order to executor:orders to test." />
          ) : (
            <Table
              rowKey={(record) => `${record.orderId}-${record.status}-${record.timestamp}`}
              columns={executionColumns}
              dataSource={executions}
              pagination={false}
              scroll={{ x: 1100, y: 320 }}
              size="small"
              virtual
            />
          )}
        </Card>

        <Card title="Gateway Event Stream">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap>
              <Segmented<StreamScope>
                options={[
                  { label: 'All', value: 'all' },
                  { label: 'Markets', value: 'markets' },
                  { label: 'Health', value: 'health' },
                  { label: 'System', value: 'system' },
                  { label: 'Redis', value: 'redis' },
                ]}
                value={scope}
                onChange={(value) => setScope(value)}
              />
              <Segmented<string>
                options={channelOptions}
                value={channelFilter}
                onChange={(value) => setChannelFilter(value)}
              />
              <Input.Search
                allowClear
                placeholder="Search in event payload"
                style={{ width: 280 }}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Space>

            <Divider style={{ margin: 0 }} />

            {filteredEvents.length === 0 ? (
              <Empty description="No events match current filters." />
            ) : (
              <Table
                rowKey={(record, index) => `${record.timestamp}-${index ?? 0}`}
                columns={eventColumns}
                dataSource={filteredEvents}
                pagination={false}
                scroll={{ x: 1200, y: 480 }}
                size="small"
                virtual
              />
            )}
          </Space>
        </Card>
      </Space>
    </div>
  );
};

export default App;
