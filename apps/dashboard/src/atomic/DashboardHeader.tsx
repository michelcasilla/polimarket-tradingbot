import { Badge, Button, Card, Space, Switch, Tag, Typography } from 'antd';
import { Flex } from 'antd/es';

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
    <Flex>
      <Flex flex={1} vertical>
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
      </Flex>
      <Flex align="end" justify='center'>
        <Space size={10} wrap>
          <Tag color="green">Wins: {wins}</Tag>
          <Tag color="red">Losses: {losses}</Tag>
        </Space>
        <Space size={6}>
          <Text type="secondary">Simulation</Text>
          <Switch size="small" checked={liveMode} onChange={onLiveModeChange} />
          <Text type="secondary">Live</Text>
        </Space>
      </Flex>
    </Flex>
  </Card>
);
