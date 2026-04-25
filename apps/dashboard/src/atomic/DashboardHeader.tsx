import { Badge, Button, Card, Space, Switch, Tag, Typography } from 'antd';

const { Title, Text } = Typography;

const connectionColor = {
  connecting: 'processing',
  open: 'success',
  closed: 'default',
  error: 'error',
} as const;

export type ConnectionStatus = keyof typeof connectionColor;

export interface DashboardHeaderProps {
  status: ConnectionStatus;
  wsUrl: string;
  wins: number;
  losses: number;
  liveMode: boolean;
  onLiveModeChange: (live: boolean) => void;
  onClearEvents: () => void;
  onResetFilters: () => void;
}

export const DashboardHeader = ({
  status,
  wsUrl,
  wins,
  losses,
  liveMode,
  onLiveModeChange,
  onClearEvents,
  onResetFilters,
}: DashboardHeaderProps) => (
  <Card className="compact-card">
    <Space direction="horizontal" size={8} style={{ width: '100%' }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Title level={3} style={{ margin: 0 }}>
          Polymarket HFT Dashboard
        </Title>
        <Text type="secondary">
          Real-time monitor connected to <span className="mono">dashboard-gateway</span>.
        </Text>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <Space size={12} wrap>
            <Badge status={connectionColor[status]} text={`Socket: ${status}`} />
            <Text className="mono">{wsUrl}</Text>
            <Button size="small" onClick={onClearEvents}>
              Clear events
            </Button>
            <Button size="small" onClick={onResetFilters}>
              Reset filters
            </Button>
          </Space>
        </div>
      </Space>
      <Space direction="vertical" size={4} align="end" style={{ width: '100%' }}>
        <Space size={10} wrap>
          <Tag color="green">Wins: {wins}</Tag>
          <Tag color="red">Losses: {losses}</Tag>
        </Space>
        <Space size={6}>
          <Text type="secondary">Simulation</Text>
          <Switch size="small" checked={liveMode} onChange={onLiveModeChange} />
          <Text type="secondary">Live</Text>
        </Space>
      </Space>
    </Space>
  </Card>
);
