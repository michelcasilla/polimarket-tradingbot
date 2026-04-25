import type { GatewayEvent } from '../types';
import type { StreamScope } from './streamTypes';

export const getChannelFromEvent = (event: GatewayEvent): string => {
  const maybeChannel = event.payload['channel'];
  return typeof maybeChannel === 'string' ? maybeChannel : 'local';
};

export const getStreamScopeFromEvent = (event: GatewayEvent): StreamScope => {
  if (event.type === 'HEALTH') return 'health';
  if (event.type === 'SYSTEM') return 'system';
  const channel = event.payload['channel'];
  if (typeof channel === 'string' && channel.startsWith('polymarket:book:')) return 'markets';
  if (event.payload['source'] === 'redis') return 'redis';
  return 'all';
};
