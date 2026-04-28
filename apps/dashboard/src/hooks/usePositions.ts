import { useMemo } from 'react';
import type { Position } from '@polymarket-bot/contracts';
import type { GatewayEvent } from '../types';
import { buildPositionList } from '../positions';

export const usePositions = (rareEvents: GatewayEvent[]): Position[] =>
  useMemo(() => buildPositionList(rareEvents), [rareEvents]);
