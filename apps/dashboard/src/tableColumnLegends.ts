export interface ColumnLegendRow {
  readonly column: string;
  readonly meaning: string;
}

/** Top Markets — order book snapshot per outcome token */
export const MARKET_TABLE_LEGEND: readonly ColumnLegendRow[] = [
  { column: 'Market', meaning: 'Condition id + human title (Redis metadata or Gamma). ⓘ opens a detail card.' },
  { column: 'Outcome', meaning: 'YES or NO outcome token for this row (binary market leg).' },
  { column: 'Mid', meaning: 'Mid-price between best bid and best ask (probability 0–1).' },
  { column: 'Best Bid', meaning: 'Highest bid price in the published book snapshot.' },
  { column: 'Best Ask', meaning: 'Lowest ask price in the published book snapshot.' },
  { column: 'Spread', meaning: 'Best ask minus best bid (tighter = more liquid top of book).' },
  { column: 'Bid Depth', meaning: 'Total size resting on bid side (all published levels).' },
  { column: 'Ask Depth', meaning: 'Total size resting on ask side (all published levels).' },
  { column: 'Vol 24h', meaning: '24h notional volume from market metadata (off-chain Gamma), not live tape.' },
  { column: 'Updated', meaning: 'Snapshot timestamp from tape-reader (last book refresh for this row).' },
];

/** Strategist signals */
export const SIGNAL_TABLE_LEGEND: readonly ColumnLegendRow[] = [
  { column: 'Market', meaning: 'Polymarket condition id the strategist is commenting on.' },
  { column: 'Outcome', meaning: 'Which token leg (YES/NO) the signal refers to.' },
  { column: 'Reason', meaning: 'Strategy label (e.g. spread capture) plus optional direction hint.' },
  { column: 'Fair', meaning: 'Model fair probability the strategist published for this outcome.' },
  { column: 'Edge (bps)', meaning: 'Fair vs current mid from tape snapshots, in basis points (100 bps = 1 pp).' },
  { column: 'Confidence', meaning: 'Signal strength 0–100% from the strategist payload.' },
  { column: 'Spread', meaning: 'Top-of-book spread from the latest snapshot used for edge.' },
  { column: 'Age', meaning: 'Time since signal; marked stale when older than the dashboard threshold.' },
];

/** Oracle (external reference) signals */
export const ORACLE_TABLE_LEGEND: readonly ColumnLegendRow[] = [
  { column: 'Topic', meaning: 'Stable topic key (e.g. BTC reference) used to correlate downstream logic.' },
  { column: 'Provider', meaning: 'Upstream data source (Binance, etc.) for this observation.' },
  { column: 'Event', meaning: 'Oracle event type / subtype from the payload.' },
  { column: 'Δ (1m)', meaning: 'Approx. one-minute percentage move from oracle payload (`deltaPct`).' },
  { column: 'Last Px', meaning: 'Reference price at window end from oracle payload (`windowEndPrice`).' },
  { column: 'Impact', meaning: 'Normalized impact score (0–1) for how strong the move is deemed.' },
  { column: 'Age', meaning: 'Time since this oracle message was received on the gateway.' },
];

/** Executor order lifecycle */
export const EXECUTION_TABLE_LEGEND: readonly ColumnLegendRow[] = [
  { column: 'Status', meaning: 'Order lifecycle state from executor (placed, filled, cancelled, etc.).' },
  { column: 'Order', meaning: 'Exchange order id (truncated) and optional strategist reason tag.' },
  { column: 'Market', meaning: 'Condition id + metadata link; same legend as Top Markets row.' },
  { column: 'Filled', meaning: 'Filled size vs requested size for this order update.' },
  { column: 'Avg Px', meaning: 'Volume-weighted average fill when filled; limit price hint when not filled.' },
  { column: 'Fees', meaning: 'Cumulative fees in USDC attributed to this result row.' },
  { column: 'Result', meaning: 'Quick win/loss indicator: ▲ green = positive PnL, ▼ red = negative, = neutral, — not yet evaluated.' },
  { column: 'PnL (mtm)', meaning: 'Mark-to-market PnL vs current best bid/ask snapshot minus fees (dashboard calc).' },
  { column: 'Reason', meaning: 'Human error or signal reason text when the executor provides it.' },
  { column: 'Age / TTL', meaning: 'Time since update; for PLACED orders shows remaining TTL until expiry.' },
  { column: 'Actions', meaning: 'Cancel resting order (PLACED / PARTIAL) via POST to dashboard-gateway → Redis executor:cancels.' },
];

/** Raw gateway / Redis stream rows */
export const GATEWAY_EVENT_TABLE_LEGEND: readonly ColumnLegendRow[] = [
  { column: 'Type', meaning: 'SYSTEM (handshake), HEALTH (heartbeat), or LOG (Redis payload mirror).' },
  { column: 'Channel', meaning: 'Redis channel name (static or polymarket:book:* pattern).' },
  { column: 'Timestamp', meaning: 'When the dashboard-gateway forwarded the message to the browser.' },
  { column: 'Payload', meaning: 'JSON body (trimmed); hover for formatted JSON tooltip.' },
];
