import { Card, Empty, Space } from 'antd';
import type { ReactNode } from 'react';

export interface DataTableCardProps {
  title: ReactNode;
  /** Static help (e.g. column glossary); no I/O. */
  columnLegend?: ReactNode;
  extra?: ReactNode;
  isEmpty: boolean;
  emptyDescription?: string;
  children: ReactNode;
  cardClassName?: string;
}

export const DataTableCard = ({
  title,
  columnLegend,
  extra,
  isEmpty,
  emptyDescription,
  children,
  cardClassName = 'compact-card',
}: DataTableCardProps) => (
  <Card
    className={cardClassName}
    title={
      columnLegend ? (
        <Space align="center" wrap size={8}>
          {title}
          {columnLegend}
        </Space>
      ) : (
        title
      )
    }
    extra={extra}
  >
    {isEmpty ? <Empty description={emptyDescription} /> : children}
  </Card>
);
