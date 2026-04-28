import { Tag } from 'antd';
import type { Position } from '@polymarket-bot/contracts';

export interface InventoryHeatmapProps {
  positions: Position[];
}

const colorForRatio = (ratio: number): string => {
  const abs = Math.abs(ratio);
  if (abs >= 0.8) return 'red';
  if (abs >= 0.5) return 'orange';
  if (abs >= 0.2) return 'gold';
  return 'green';
};

export const InventoryHeatmap = ({ positions }: InventoryHeatmapProps) => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
    {positions.map((p) => {
      const ratio = Math.max(-1, Math.min(1, p.netSize / 200));
      return (
        <Tag key={`${p.marketId}:${p.outcome}`} color={colorForRatio(ratio)}>
          {p.marketId.slice(0, 14)}… {p.outcome} {p.netSize.toFixed(2)}
        </Tag>
      );
    })}
  </div>
);
