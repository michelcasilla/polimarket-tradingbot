import type { Position } from '@polymarket-bot/contracts';
import type { GatewayEvent } from './types';

const CHANNEL = 'executor:positions';

const isPositionPayload = (data: Record<string, unknown>): data is Position =>
  typeof data['marketId'] === 'string' &&
  (data['outcome'] === 'YES' || data['outcome'] === 'NO') &&
  typeof data['netSize'] === 'number' &&
  typeof data['averageEntryPrice'] === 'number' &&
  typeof data['realizedPnlUsdc'] === 'number' &&
  typeof data['unrealizedPnlUsdc'] === 'number';

export const extractPosition = (event: GatewayEvent): Position | null => {
  const channel = event.payload['channel'];
  if (channel !== CHANNEL) return null;
  const data = event.payload['data'];
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (!isPositionPayload(obj)) return null;
  return obj as Position;
};

export const buildPositionList = (events: GatewayEvent[], limit = 200): Position[] => {
  const latest = new Map<string, Position>();
  for (const event of events) {
    const position = extractPosition(event);
    if (!position) continue;
    const key = `${position.marketId}:${position.outcome}`;
    if (!latest.has(key)) latest.set(key, position);
    if (latest.size >= limit) break;
  }
  return Array.from(latest.values());
};
