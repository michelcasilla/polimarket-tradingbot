import { useCallback } from 'react';
import { isStreamScope, type StreamScope } from '../atomic';
import { useLocalStorage } from '../useLocalStorage';

const isString = (value: unknown): value is string => typeof value === 'string';

export const useDashboardFilters = () => {
  const [scope, setScope] = useLocalStorage<StreamScope>('dash.scope', 'all', isStreamScope);
  const [channelFilter, setChannelFilter] = useLocalStorage<string>(
    'dash.channelFilter',
    'all',
    isString,
  );
  const [search, setSearch] = useLocalStorage<string>('dash.search', '', isString);

  const resetFilters = useCallback(() => {
    setScope('all');
    setChannelFilter('all');
    setSearch('');
  }, [setScope, setChannelFilter, setSearch]);

  return {
    scope,
    setScope,
    channelFilter,
    setChannelFilter,
    search,
    setSearch,
    resetFilters,
  };
};
