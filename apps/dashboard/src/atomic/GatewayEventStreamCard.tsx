import { Button, Card, Divider, Empty, Input, Result, Segmented, Space, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ReactNode } from 'react';
import type { GatewayEvent } from '../types';
import type { StreamScope } from './streamTypes';

export interface GatewayEventStreamCardProps {
  /** When false, filters and table are hidden and the parent should not feed live events into filters. */
  listening: boolean;
  onListeningChange: (listening: boolean) => void;
  scope: StreamScope;
  onScopeChange: (value: StreamScope) => void;
  channelOptions: string[];
  channelFilter: string;
  onChannelFilterChange: (value: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  filteredEvents: GatewayEvent[];
  columns: ColumnsType<GatewayEvent>;
  /** Static column glossary next to the card title. */
  columnLegend?: ReactNode;
}

const cardTitle = (columnLegend: ReactNode | undefined) =>
  columnLegend ? (
    <Space align="center" wrap size={8}>
      <span>Gateway Event Stream</span>
      {columnLegend}
    </Space>
  ) : (
    'Gateway Event Stream'
  );

export const GatewayEventStreamCard = ({
  listening,
  onListeningChange,
  scope,
  onScopeChange,
  channelOptions,
  channelFilter,
  onChannelFilterChange,
  search,
  onSearchChange,
  filteredEvents,
  columns,
  columnLegend,
}: GatewayEventStreamCardProps) => {
  if (!listening) {
    return (
      <Card title={cardTitle(columnLegend)}>
        <Result
          status="info"
          title="Event stream idle"
          subTitle="The live event table is off until you start listening. That skips filtering and rendering high-volume book traffic so the rest of the dashboard stays lighter."
          extra={
            <Button type="primary" size="large" onClick={() => onListeningChange(true)}>
              LISTEN
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <Card title={cardTitle(columnLegend)}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap align="center">
          <Button size="small" onClick={() => onListeningChange(false)}>
            Pause stream
          </Button>
          <Segmented<StreamScope>
            options={[
              { label: 'All', value: 'all' },
              { label: 'Markets', value: 'markets' },
              { label: 'Health', value: 'health' },
              { label: 'System', value: 'system' },
              { label: 'Redis', value: 'redis' },
            ]}
            value={scope}
            onChange={(value) => onScopeChange(value)}
          />
          <Segmented<string>
            options={channelOptions}
            value={channelFilter}
            onChange={(value) => onChannelFilterChange(value)}
          />
          <Input.Search
            allowClear
            placeholder="Search in event payload"
            style={{ width: 280 }}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </Space>

        <Divider style={{ margin: 0 }} />

        {filteredEvents.length === 0 ? (
          <Empty description="No events match current filters." />
        ) : (
          <Table
            className="compact-table"
            rowKey={(record, index) => `${record.timestamp}-${index ?? 0}`}
            columns={columns}
            dataSource={filteredEvents}
            pagination={false}
            scroll={{ x: 1200, y: 480 }}
            size="small"
            virtual
          />
        )}
      </Space>
    </Card>
  );
};
