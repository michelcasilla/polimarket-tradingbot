export type GatewayEventType = 'SYSTEM' | 'HEALTH' | 'LOG';

export interface GatewayEvent {
  type: GatewayEventType;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface UiMetric {
  key: string;
  label: string;
  value: string;
}
