import type { GatewayEvent } from './types';

export interface OracleSignalView {
  id: string;
  provider: string;
  eventType: string;
  topic: string;
  impactScore: number;
  timestamp: number;
  raw: Record<string, unknown>;
}

const isOracleChannel = (channel: unknown): channel is string =>
  channel === 'oracle:signals';

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const extractOracleSignal = (event: GatewayEvent): OracleSignalView | null => {
  if (!isOracleChannel(event.payload['channel'])) return null;
  const data = event.payload['data'];
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const id = stringOrNull(d['id']);
  const provider = stringOrNull(d['provider']);
  const eventType = stringOrNull(d['eventType']);
  const topic = stringOrNull(d['topic']);
  const impactScore = numberOrNull(d['impactScore']);
  const timestamp = numberOrNull(d['timestamp']) ?? event.timestamp;
  if (!id || !provider || !eventType || !topic || impactScore === null) return null;
  return {
    id,
    provider,
    eventType,
    topic,
    impactScore,
    timestamp,
    raw: (d['rawData'] as Record<string, unknown>) ?? {},
  };
};

/** Latest oracle signal per topic (most recent first). */
export const buildOracleMap = (events: GatewayEvent[]): OracleSignalView[] => {
  const latestByTopic = new Map<string, OracleSignalView>();
  for (const event of events) {
    const sig = extractOracleSignal(event);
    if (!sig) continue;
    const existing = latestByTopic.get(sig.topic);
    if (!existing || sig.timestamp > existing.timestamp) {
      latestByTopic.set(sig.topic, sig);
    }
  }
  return Array.from(latestByTopic.values()).sort((a, b) => b.timestamp - a.timestamp);
};
