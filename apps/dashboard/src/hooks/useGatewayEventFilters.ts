import { useMemo } from 'react';
import { getChannelFromEvent, getStreamScopeFromEvent } from '../atomic';
import type { StreamScope } from '../atomic';
import type { GatewayEvent } from '../types';

export const useGatewayEventFilters = (
  events: GatewayEvent[],
  scope: StreamScope,
  channelFilter: string,
  search: string,
) => {
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

  return { channelOptions, filteredEvents };
};
