import { Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Position } from '@polymarket-bot/contracts';
import { formatPnl } from '../formatting';

const columns: ColumnsType<Position> = [
  { title: 'Market', dataIndex: 'marketId', key: 'marketId', width: 320 },
  {
    title: 'Outcome',
    dataIndex: 'outcome',
    key: 'outcome',
    width: 90,
    render: (value: Position['outcome']) => (
      <Tag color={value === 'YES' ? 'green' : 'volcano'}>{value}</Tag>
    ),
  },
  {
    title: 'Net Size',
    dataIndex: 'netSize',
    key: 'netSize',
    width: 120,
    align: 'right',
    render: (value: number) => <span className="mono">{value.toFixed(2)}</span>,
  },
  {
    title: 'Avg Entry',
    dataIndex: 'averageEntryPrice',
    key: 'averageEntryPrice',
    width: 120,
    align: 'right',
    render: (value: number) => <span className="mono">{value.toFixed(3)}</span>,
  },
  {
    title: 'Realized',
    dataIndex: 'realizedPnlUsdc',
    key: 'realizedPnlUsdc',
    width: 120,
    align: 'right',
    render: (value: number) => <span className="mono">{formatPnl(value)}</span>,
  },
  {
    title: 'Unrealized',
    dataIndex: 'unrealizedPnlUsdc',
    key: 'unrealizedPnlUsdc',
    width: 120,
    align: 'right',
    render: (value: number) => <span className="mono">{formatPnl(value)}</span>,
  },
  {
    title: 'Source',
    dataIndex: 'source',
    key: 'source',
    width: 120,
    render: (value: Position['source']) => <Tag>{value}</Tag>,
  },
];

export interface PositionsTableProps {
  positions: Position[];
}

export const PositionsTable = ({ positions }: PositionsTableProps) => (
  <Table
    className="compact-table"
    rowKey={(record) => `${record.marketId}:${record.outcome}`}
    columns={columns}
    dataSource={positions}
    pagination={false}
    scroll={{ x: 1000, y: 240 }}
    size="small"
    virtual
  />
);
