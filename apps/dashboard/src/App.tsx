import {
  Button,
  Layout,
  Menu,
  message,
  Popconfirm,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  DashboardOutlined,
  TableOutlined,
  FileTextOutlined,
  AppstoreOutlined,
  RadarChartOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  DollarOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import {
  ColumnLegendPopover,
  DataTableCard,
  DashboardHeader,
  GatewayEventStreamCard,
  getChannelFromEvent,
  InventoryHeatmap,
  MarketLineWithFicha,
  MetricsStrip,
  PositionsTable,
} from './atomic';
import { formatPnl } from './formatting';
import {
  useDashboardAggregates,
  useDashboardFilters,
  useExecutorStatus,
  useGatewayEventFilters,
  useNowTick,
  usePositions,
} from './hooks';
import type { GatewayEvent } from './types';

/** Stable empty list so `useGatewayEventFilters` skips work when the event stream UI is paused. */
const EMPTY_GATEWAY_EVENTS: GatewayEvent[] = [];
import { useGatewaySocket } from './useGatewaySocket';
import {
  formatProb,
  formatSize,
  formatSpread,
  truncateId,
  type MarketSnapshot,
} from './market';
import { isStale, liveEdgeBps, type StrategistSignal } from './signals';
import { type OracleSignalView } from './oracle';
import { type MarketMetadataView } from './metadata';
import {
  computeLivePnlUsdc,
  type ExecutionResultView,
  type ExecutionStatus,
  type ExecutorRunMode,
} from './execution';
import {
  EXECUTION_TABLE_LEGEND,
  GATEWAY_EVENT_TABLE_LEGEND,
  MARKET_TABLE_LEGEND,
  ORACLE_TABLE_LEGEND,
  SIGNAL_TABLE_LEGEND,
} from './tableColumnLegends';
import { cancelOrder, panicExecutor, resumeExecutor } from './executorControl';

const { Text } = Typography;
const { Header, Sider, Content } = Layout;
type DashboardView =
  | 'dashboard'
  | 'markets'
  | 'signals'
  | 'execution'
  | 'trades'
  | 'risk'
  | 'rewards'
  | 'logs';

const VIEW_ROUTES: Record<DashboardView, string> = {
  dashboard: '/dashboard',
  markets: '/markets',
  signals: '/signals',
  execution: '/execution',
  trades: '/trades',
  risk: '/risk',
  rewards: '/rewards',
  logs: '/logs',
};

const ROUTE_TO_VIEW: Record<string, DashboardView> = Object.fromEntries(
  Object.entries(VIEW_ROUTES).map(([view, route]) => [route, view as DashboardView]),
) as Record<string, DashboardView>;

const parseViewFromHash = (): DashboardView => {
  const hash = window.location.hash || '#/dashboard';
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  return ROUTE_TO_VIEW[path] ?? 'dashboard';
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

const polymarketEventUrl = (slug: string): string => `https://polymarket.com/event/${slug}`;

/**
 * Polymarket's website resolves URLs by **event** slug, not by market slug.
 * For multi-outcome events the per-market slug 404s ("Oops...we didn't
 * forecast this"). Always prefer `eventSlug` and fall back to `slug` only
 * for legacy single-market events where they coincide.
 */
const resolveMarketHref = (meta: MarketMetadataView | undefined): string | null => {
  if (!meta) return null;
  if (meta.eventSlug) return polymarketEventUrl(meta.eventSlug);
  if (meta.slug) return polymarketEventUrl(meta.slug);
  return null;
};

const buildSignalColumns = (
  snapshots: MarketSnapshot[],
  metadataMap: Map<string, MarketMetadataView>,
  now: number,
): ColumnsType<StrategistSignal> => [
  {
    title: 'Market',
    key: 'marketId',
    render: (_: unknown, record) => {
      const meta = metadataMap.get(record.marketId);
      const href = resolveMarketHref(meta);
      return (
        <MarketLineWithFicha
          marketId={record.marketId}
          meta={meta}
          polymarketHref={href}
          textStrong={false}
          maxLabelWidth={260}
        />
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
    width: 150,
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
      const px =
        typeof raw['windowEndPrice'] === 'number' ? (raw['windowEndPrice'] as number) : null;
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

const buildExecutionColumns = (
  metadataMap: Map<string, MarketMetadataView>,
  snapshots: MarketSnapshot[],
  now: number,
): ColumnsType<ExecutionResultView> => [
  {
    title: 'Status',
    key: 'status',
    width: 200,
    render: (_: unknown, record) => (
      <Space direction="horizontal" size={2} style={{ rowGap: 2 }}>
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
      const href = resolveMarketHref(meta);
      return (
        <MarketLineWithFicha
          marketId={record.marketId}
          meta={meta}
          polymarketHref={href}
          textStrong={false}
          maxLabelWidth={280}
        />
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
                record.filledSize === 0
                  ? 'rgba(255,255,255,0.45)'
                  : fullyFilled
                    ? '#52c41a'
                    : '#faad14',
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
    title: 'Result',
    key: 'result',
    align: 'center',
    width: 80,
    render: (_: unknown, record) => {
      const pnl = computeLivePnlUsdc(record, snapshots);
      if (pnl === null) {
        return (
          <Tooltip title="Not evaluated (no fill or no live mark)">
            <span className="mono" style={{ color: 'rgba(255,255,255,0.35)' }}>—</span>
          </Tooltip>
        );
      }
      if (pnl > 0) {
        return (
          <Tooltip title="Winning trade (mark-to-market positive)">
            <span className="mono" style={{ color: '#52c41a', fontWeight: 700, fontSize: 14 }}>▲</span>
          </Tooltip>
        );
      }
      if (pnl < 0) {
        return (
          <Tooltip title="Losing trade (mark-to-market negative)">
            <span className="mono" style={{ color: '#ff4d4f', fontWeight: 700, fontSize: 14 }}>▼</span>
          </Tooltip>
        );
      }
      return (
        <Tooltip title="Even (mark-to-market = 0)">
          <span className="mono" style={{ color: 'rgba(255,255,255,0.55)' }}>=</span>
        </Tooltip>
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
        return (
          <span className="mono" style={{ color: 'rgba(255,255,255,0.35)' }}>
            —
          </span>
        );
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
  {
    title: 'Actions',
    key: 'actions',
    width: 100,
    align: 'center',
    render: (_: unknown, record) => {
      const cancelable = record.status === 'PLACED' || record.status === 'PARTIALLY_FILLED';
      if (!cancelable) {
        return <span className="mono" style={{ color: 'rgba(255,255,255,0.25)' }}>—</span>;
      }
      return (
        <Popconfirm
          title={`Cancel order ${truncateId(record.orderId, 8, 6)}?`}
          okText="Cancel order"
          cancelText="Back"
          okButtonProps={{ danger: true }}
          onConfirm={() => {
            void cancelOrder(record.orderId, record.marketId)
              .then(async (res) => {
                if (!res.ok) {
                  message.error(await res.text());
                  return;
                }
                message.success('Cancel request sent');
              })
              .catch(() => {
                message.error('Failed to reach dashboard-gateway');
              });
          }}
        >
          <Button size="small" danger type="link">
            Cancel
          </Button>
        </Popconfirm>
      );
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
      const href = resolveMarketHref(meta);
      return (
        <MarketLineWithFicha
          marketId={record.marketId}
          meta={meta}
          polymarketHref={href}
          textStrong
          maxLabelWidth={300}
        />
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

  const { scope, setScope, channelFilter, setChannelFilter, search, setSearch, resetFilters } =
    useDashboardFilters();

  const now = useNowTick(500);

  const {
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
  } = useDashboardAggregates(events, rareEvents, now, {
    status,
    eventsPerSecond,
    bufferLimit,
    totalReceived,
  });

  const executorStatus = useExecutorStatus(rareEvents);
  const executorPaused = executorStatus?.paused ?? false;
  const positions = usePositions(rareEvents);

  const signalColumns = useMemo(
    () => buildSignalColumns(snapshots, metadataMap, now),
    [snapshots, metadataMap, now],
  );
  const oracleColumns = useMemo(() => buildOracleColumns(now), [now]);
  const marketColumns = useMemo(() => buildMarketColumns(metadataMap), [metadataMap]);
  const executionColumns = useMemo(
    () => buildExecutionColumns(metadataMap, snapshots, now),
    [metadataMap, snapshots, now],
  );
  const [uiLiveMode, setUiLiveMode] = useState(false);
  const [gatewayStreamListening, setGatewayStreamListening] = useState(false);
  const [executionModeFilter, setExecutionModeFilter] = useState<ExecutorRunMode>('simulation');
  const [activeView, setActiveView] = useState<DashboardView>(parseViewFromHash);
  const [collapsed, setCollapsed] = useState(false);
  const {
    token: { colorBgContainer, borderRadiusLG },
  } = theme.useToken();
  const showMarkets = activeView === 'dashboard' || activeView === 'markets';
  const showSignals = activeView === 'dashboard' || activeView === 'signals';
  const showExecution = activeView === 'dashboard' || activeView === 'execution';
  const showRisk = activeView === 'dashboard' || activeView === 'risk';
  const showRewards = activeView === 'dashboard' || activeView === 'rewards';

  useEffect(() => {
    const onHashChange = () => setActiveView(parseViewFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const targetHash = `#${VIEW_ROUTES[activeView]}`;
    if (window.location.hash !== targetHash) {
      window.history.replaceState(null, '', targetHash);
    }
  }, [activeView]);

  const filteredExecutions = useMemo(
    () =>
      executions.filter(
        (e) => (e.executorMode ?? 'simulation') === executionModeFilter,
      ),
    [executions, executionModeFilter],
  );

  const executionCardMetrics = useMemo(() => {
    let fills = 0;
    let sum = 0;
    let counted = 0;
    for (const e of filteredExecutions) {
      if (e.status === 'FILLED') fills += 1;
      const pnl = computeLivePnlUsdc(e, snapshots);
      if (pnl !== null) {
        sum += pnl;
        counted += 1;
      }
    }
    return { fillCount: fills, livePnlUsdc: { sum, counted } };
  }, [filteredExecutions, snapshots]);

  const { channelOptions, filteredEvents } = useGatewayEventFilters(
    gatewayStreamListening ? events : EMPTY_GATEWAY_EVENTS,
    scope,
    channelFilter,
    search,
  );

  const rewardScores = useMemo(() => {
    const rows: Array<{
      marketId: string;
      outcome: 'YES' | 'NO';
      expectedScore: number;
      size: number;
      computedAt: number;
    }> = [];
    for (const e of rareEvents) {
      if (e.payload['channel'] !== 'strategist:reward-scores') continue;
      const data = e.payload['data'];
      if (!data || typeof data !== 'object') continue;
      const d = data as Record<string, unknown>;
      if (
        typeof d['marketId'] !== 'string' ||
        (d['outcome'] !== 'YES' && d['outcome'] !== 'NO') ||
        typeof d['expectedScore'] !== 'number' ||
        typeof d['size'] !== 'number'
      ) {
        continue;
      }
      rows.push({
        marketId: d['marketId'],
        outcome: d['outcome'],
        expectedScore: d['expectedScore'],
        size: d['size'],
        computedAt: typeof d['computedAt'] === 'number' ? d['computedAt'] : e.timestamp,
      });
      if (rows.length >= 30) break;
    }
    return rows;
  }, [rareEvents]);

  const pnlAttribution = useMemo(() => {
    const agg = new Map<string, { pnl: number; count: number }>();
    for (const exec of executions) {
      const pnl = computeLivePnlUsdc(exec, snapshots);
      if (pnl === null) continue;
      const key = exec.signalReason ?? 'unknown';
      const cur = agg.get(key) ?? { pnl: 0, count: 0 };
      cur.pnl += pnl;
      cur.count += 1;
      agg.set(key, cur);
    }
    return Array.from(agg.entries()).map(([reason, value]) => ({ reason, ...value }));
  }, [executions, snapshots]);

  const historicalTrades = useMemo(
    () =>
      executions
        .filter((e) => e.status === 'FILLED' && e.filledSize > 0)
        .map((e) => ({ ...e, pnl: computeLivePnlUsdc(e, snapshots) }))
        .sort((a, b) => b.timestamp - a.timestamp),
    [executions, snapshots],
  );

  const tradeHistoryColumns: ColumnsType<(ExecutionResultView & { pnl: number | null })> = useMemo(
    () => [
      {
        title: 'Time',
        key: 'timestamp',
        width: 110,
        render: (_: unknown, record) => (
          <span className="mono">{new Date(record.timestamp).toLocaleTimeString()}</span>
        ),
      },
      {
        title: 'Market',
        key: 'marketId',
        render: (_: unknown, record) => {
          const meta = metadataMap.get(record.marketId);
          const href = resolveMarketHref(meta);
          return (
            <MarketLineWithFicha
              marketId={record.marketId}
              meta={meta}
              polymarketHref={href}
              textStrong={false}
              maxLabelWidth={320}
            />
          );
        },
      },
      {
        title: 'Side',
        key: 'side',
        width: 110,
        render: (_: unknown, record) => (
          <Tag color={record.side === 'BUY' ? 'green' : 'volcano'}>
            {record.side ?? '—'} {record.outcome ?? ''}
          </Tag>
        ),
      },
      {
        title: 'Size',
        key: 'size',
        align: 'right',
        width: 100,
        render: (_: unknown, record) => <span className="mono">{record.filledSize.toFixed(2)}</span>,
      },
      {
        title: 'Avg Px',
        key: 'avg',
        align: 'right',
        width: 100,
        render: (_: unknown, record) => (
          <span className="mono">{record.averagePrice !== null ? formatProb(record.averagePrice) : '—'}</span>
        ),
      },
      {
        title: 'Fees',
        key: 'fees',
        align: 'right',
        width: 90,
        render: (_: unknown, record) => <span className="mono">${(record.fees ?? 0).toFixed(4)}</span>,
      },
      {
        title: 'PnL',
        key: 'pnl',
        align: 'right',
        width: 120,
        render: (_: unknown, record) => {
          if (record.pnl === null) return <span className="mono">—</span>;
          const color = record.pnl > 0 ? '#52c41a' : record.pnl < 0 ? '#ff4d4f' : undefined;
          return (
            <span className="mono" style={{ color, fontWeight: 600 }}>
              {formatPnl(record.pnl)}
            </span>
          );
        },
      },
      {
        title: 'Result',
        key: 'result',
        width: 90,
        align: 'center',
        render: (_: unknown, record) => {
          if (record.pnl === null) return <span className="mono">—</span>;
          if (record.pnl > 0) return <span style={{ color: '#52c41a', fontWeight: 700 }}>WIN</span>;
          if (record.pnl < 0) return <span style={{ color: '#ff4d4f', fontWeight: 700 }}>LOSS</span>;
          return <span className="mono">EVEN</span>;
        },
      },
    ],
    [metadataMap],
  );

  return (
    <Layout className="dashboard-shell">
      <Sider trigger={null} collapsible collapsed={collapsed}>
        <div className="dashboard-logo">{collapsed ? 'PB' : 'PoliPilot'}</div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[activeView]}
          onClick={(info) => setActiveView(info.key as DashboardView)}
          items={[
            { key: 'dashboard', icon: <DashboardOutlined />, label: 'Dashboard' },
            { key: 'markets', icon: <AppstoreOutlined />, label: 'Markets' },
            { key: 'signals', icon: <RadarChartOutlined />, label: 'Signals' },
            { key: 'execution', icon: <PlayCircleOutlined />, label: 'Execution' },
            { key: 'trades', icon: <TableOutlined />, label: 'Trades' },
            { key: 'risk', icon: <SafetyCertificateOutlined />, label: 'Risk' },
            { key: 'rewards', icon: <DollarOutlined />, label: 'Rewards' },
            { key: 'logs', icon: <FileTextOutlined />, label: 'Logs' },
          ]}
        />
      </Sider>
      <Layout>
        <Header style={{ padding: 0, background: colorBgContainer }}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            style={{ fontSize: '16px', width: 64, height: 64 }}
          />
        </Header>
        <Content
          style={{
            margin: '16px',
            padding: 16,
            minHeight: 280,
            background: colorBgContainer,
            borderRadius: borderRadiusLG,
          }}
        >
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <DashboardHeader
          status={status}
          wsUrl={wsUrl}
          wins={tradeOutcomes.wins}
          losses={tradeOutcomes.losses}
          liveMode={uiLiveMode}
          onLiveModeChange={setUiLiveMode}
          onClearEvents={clearEvents}
          onResetFilters={resetFilters}
        />

          <MetricsStrip metrics={metrics} />

          <>
              {showMarkets && <DataTableCard
          title="Top Markets (bot-tape-reader)"
          columnLegend={<ColumnLegendPopover label="Top Markets columns" rows={MARKET_TABLE_LEGEND} />}
          extra={
            <Text type="secondary">
              {snapshots.length === 0
                ? 'Waiting for first snapshot…'
                : `${snapshots.length} markets · ${metadataMap.size} with metadata · live from bot-tape-reader`}
            </Text>
          }
          isEmpty={snapshots.length === 0}
          emptyDescription="No order book snapshots received yet. Verify that bot-tape-reader is healthy."
        >
          <Table
            className="compact-table"
            rowKey={(record) => `${record.marketId}-${record.outcome}`}
            columns={marketColumns}
            dataSource={snapshots}
            pagination={false}
            scroll={{ x: 1300, y: 420 }}
            size="small"
            virtual
          />
              </DataTableCard>}

              {showSignals && <DataTableCard
          title="Strategist Signals (bot-strategist)"
          columnLegend={<ColumnLegendPopover label="Strategist columns" rows={SIGNAL_TABLE_LEGEND} />}
          extra={
            <Text type="secondary">
              {liveSignals.length === 0
                ? signals.length === 0
                  ? 'Waiting for first signal…'
                  : `${signals.length} historical (all stale)`
                : `${liveSignals.length} live · ${signals.length} total in buffer`}
            </Text>
          }
          isEmpty={signals.length === 0}
          emptyDescription="No strategist signals received yet. Check bot-strategist health."
        >
          <Table
            className="compact-table"
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
              </DataTableCard>}

              {showSignals && <DataTableCard
          title="Oracle Signals (bot-oracle)"
          columnLegend={<ColumnLegendPopover label="Oracle columns" rows={ORACLE_TABLE_LEGEND} />}
          extra={
            <Text type="secondary">
              {oracleSignals.length === 0
                ? 'Waiting for first oracle signal…'
                : `${oracleSignals.length} topics tracked · live from bot-oracle`}
            </Text>
          }
          isEmpty={oracleSignals.length === 0}
          emptyDescription="No oracle signals yet. Confirm bot-oracle is connected to Binance."
        >
          <Table
            className="compact-table"
            rowKey={(record) => record.topic}
            columns={oracleColumns}
            dataSource={oracleSignals}
            pagination={false}
            scroll={{ x: 1000, y: 280 }}
            size="small"
            virtual
          />
              </DataTableCard>}

              {showExecution && <DataTableCard
          title="Execution Results (bot-executor)"
          columnLegend={<ColumnLegendPopover label="Execution columns" rows={EXECUTION_TABLE_LEGEND} />}
          extra={
            <Space size={8} align="center" wrap>
              {executorPaused && (
                <Tooltip title="Executor rejects new orders until resumed. Simulation: resting orders were cancelled on panic.">
                  <Tag color="red">PAUSED</Tag>
                </Tooltip>
              )}
              {executorPaused ? (
                <Popconfirm
                  title="Resume accepting new orders?"
                  okText="Resume"
                  onConfirm={() => {
                    void resumeExecutor()
                      .then(async (res) => {
                        if (!res.ok) {
                          message.error(await res.text());
                          return;
                        }
                        message.success('Resume sent');
                      })
                      .catch(() => {
                        message.error('Failed to reach dashboard-gateway');
                      });
                  }}
                >
                  <Button size="small" type="primary">
                    Resume
                  </Button>
                </Popconfirm>
              ) : (
                <Popconfirm
                  title="Pause executor and cancel all open resting orders (simulation)?"
                  okText="Panic"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => {
                    void panicExecutor()
                      .then(async (res) => {
                        if (!res.ok) {
                          message.error(await res.text());
                          return;
                        }
                        message.success('Panic sent');
                      })
                      .catch(() => {
                        message.error('Failed to reach dashboard-gateway');
                      });
                  }}
                >
                  <Button size="small" danger>
                    Panic
                  </Button>
                </Popconfirm>
              )}
              <Tooltip title="Filter by mode the executor stamped on each result. Older events without a tag count as Simulation.">
                <Switch
                  checked={executionModeFilter === 'live'}
                  onChange={(checked) => setExecutionModeFilter(checked ? 'live' : 'simulation')}
                  checkedChildren="Live"
                  unCheckedChildren="Sim"
                />
              </Tooltip>
              <Text type="secondary">
                {executions.length === 0
                  ? 'Waiting for first execution result…'
                  : filteredExecutions.length === 0
                    ? `No rows for ${executionModeFilter === 'live' ? 'Live' : 'Simulation'} · ${executions.length} total in buffer`
                    : executionCardMetrics.livePnlUsdc.counted === 0
                      ? `${executionCardMetrics.fillCount} fills · ${filteredExecutions.length} recent results`
                      : `${executionCardMetrics.fillCount} fills · PnL ${formatPnl(executionCardMetrics.livePnlUsdc.sum)} (${executionCardMetrics.livePnlUsdc.counted} marked) · ${filteredExecutions.length} recent`}
              </Text>
            </Space>
          }
          isEmpty={filteredExecutions.length === 0}
          emptyDescription={
            executions.length === 0
              ? 'No execution results yet. Publish an order to executor:orders to test.'
              : `No execution results for ${executionModeFilter === 'live' ? 'Live' : 'Simulation'}. Switch modes or wait for matching executor events.`
          }
        >
          <Table
            className="compact-table"
            rowKey={(record) => `${record.orderId}-${record.status}-${record.timestamp}`}
            columns={executionColumns}
            dataSource={filteredExecutions}
            pagination={false}
            scroll={{ x: 1250, y: 320 }}
            size="small"
            virtual
          />
              </DataTableCard>}

              {showRisk && <DataTableCard
          title="Positions (bot-executor)"
          extra={
            <Text type="secondary">
              {positions.length === 0
                ? 'Waiting for first position update…'
                : `${positions.length} open market/outcome positions`}
            </Text>
          }
          isEmpty={positions.length === 0}
          emptyDescription="No position updates yet. Executor publishes `executor:positions` after fills."
        >
          <PositionsTable positions={positions} />
              </DataTableCard>}

              {showRewards && <DataTableCard
          title="Maker Rewards (estimated)"
          extra={<Text type="secondary">{rewardScores.length} recent score points</Text>}
          isEmpty={rewardScores.length === 0}
          emptyDescription="No reward score events yet (`strategist:reward-scores`)."
        >
          <Table
            className="compact-table"
            rowKey={(record) => `${record.marketId}:${record.outcome}:${record.computedAt}`}
            dataSource={rewardScores}
            pagination={false}
            size="small"
            columns={[
              { title: 'Market', dataIndex: 'marketId', key: 'marketId' },
              { title: 'Outcome', dataIndex: 'outcome', key: 'outcome', width: 90 },
              {
                title: 'Expected Score',
                dataIndex: 'expectedScore',
                key: 'expectedScore',
                align: 'right',
                width: 140,
                render: (v: number) => <span className="mono">{v.toFixed(3)}</span>,
              },
              {
                title: 'Size',
                dataIndex: 'size',
                key: 'size',
                align: 'right',
                width: 120,
                render: (v: number) => <span className="mono">{v.toFixed(2)}</span>,
              },
            ]}
          />
              </DataTableCard>}

              {showRisk && <DataTableCard
          title="Inventory Heatmap"
          extra={<Text type="secondary">Exposure by market/outcome</Text>}
          isEmpty={positions.length === 0}
          emptyDescription="No inventory to render."
        >
          <InventoryHeatmap positions={positions} />
              </DataTableCard>}

              {showRewards && <DataTableCard
          title="PnL Attribution (by reason)"
          extra={<Text type="secondary">{pnlAttribution.length} strategy buckets</Text>}
          isEmpty={pnlAttribution.length === 0}
          emptyDescription="No attributed PnL yet."
        >
          <Table
            className="compact-table"
            rowKey={(record) => record.reason}
            dataSource={pnlAttribution}
            pagination={false}
            size="small"
            columns={[
              { title: 'Reason', dataIndex: 'reason', key: 'reason' },
              { title: 'Trades', dataIndex: 'count', key: 'count', align: 'right', width: 100 },
              {
                title: 'PnL',
                dataIndex: 'pnl',
                key: 'pnl',
                align: 'right',
                width: 140,
                render: (v: number) => <span className="mono">{formatPnl(v)}</span>,
              },
            ]}
          />
              </DataTableCard>}

            </>

          {activeView === 'trades' && (
            <DataTableCard
              title="Trades History"
              extra={
                <Text type="secondary">
                  {historicalTrades.length} trades en buffer · {historicalTrades.filter((t) => (t.pnl ?? 0) > 0).length}{' '}
                  wins · {historicalTrades.filter((t) => (t.pnl ?? 0) < 0).length} losses
                </Text>
              }
              isEmpty={historicalTrades.length === 0}
              emptyDescription="Aun no hay trades filled en el historial."
            >
              <Table
                className="compact-table"
                rowKey={(record) => `${record.orderId}-${record.timestamp}`}
                columns={tradeHistoryColumns}
                dataSource={historicalTrades}
                pagination={{ pageSize: 25, showSizeChanger: false }}
                scroll={{ x: 1100, y: 640 }}
                size="small"
              />
            </DataTableCard>
          )}

          {activeView === 'logs' && (
            <GatewayEventStreamCard
              listening={gatewayStreamListening}
              onListeningChange={setGatewayStreamListening}
              scope={scope}
              onScopeChange={setScope}
              channelOptions={channelOptions}
              channelFilter={channelFilter}
              onChannelFilterChange={setChannelFilter}
              search={search}
              onSearchChange={setSearch}
              filteredEvents={filteredEvents}
              columns={eventColumns}
              columnLegend={
                <ColumnLegendPopover label="Event stream columns" rows={GATEWAY_EVENT_TABLE_LEGEND} />
              }
            />
          )}
          </Space>
        </Content>
      </Layout>
    </Layout>
  );
};

export default App;
