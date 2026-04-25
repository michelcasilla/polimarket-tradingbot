export const formatPnl = (value: number | null): string => {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const magnitude = Math.abs(value);
  if (magnitude < 0.0001) return '$0.0000';
  return `${sign}$${magnitude.toFixed(4)}`;
};
