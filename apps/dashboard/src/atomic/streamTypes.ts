export const SCOPE_VALUES = ['all', 'health', 'system', 'redis', 'markets'] as const;
export type StreamScope = (typeof SCOPE_VALUES)[number];

export const isStreamScope = (value: unknown): value is StreamScope =>
  typeof value === 'string' && (SCOPE_VALUES as readonly string[]).includes(value);
