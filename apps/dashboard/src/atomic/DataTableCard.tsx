import { Card, Empty, Flex } from 'antd';
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
    title={title}
    extra={
      <Flex align="center" gap={8} justify="flex-end" wrap={false} style={{ whiteSpace: 'nowrap' }}>
        {extra}
        {columnLegend}
      </Flex>
    }
  >
    {isEmpty ? <Empty description={emptyDescription} /> : children}
  </Card>
);
