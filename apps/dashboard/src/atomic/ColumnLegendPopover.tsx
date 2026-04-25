import { Popover, Typography } from 'antd';
import type { ColumnLegendRow } from '../tableColumnLegends';

const { Text } = Typography;

export interface ColumnLegendPopoverProps {
  /** Shown as popover title */
  label?: string;
  rows: readonly ColumnLegendRow[];
}

/**
 * Static column glossary (no network). Click ⓘ next to a table title.
 */
export const ColumnLegendPopover = ({ label = 'Columns', rows }: ColumnLegendPopoverProps) => (
  <Popover
    title={label}
    trigger="click"
    destroyTooltipOnHide
    content={
      <div className="table-column-legend-body">
        {rows.map((r) => (
          <div key={r.column} className="table-column-legend-row">
            <Text strong className="table-column-legend-col">
              {r.column}
            </Text>
            <Text type="secondary" className="table-column-legend-meaning">
              {r.meaning}
            </Text>
          </div>
        ))}
      </div>
    }
  >
    <span className="table-column-legend-trigger" role="button" tabIndex={0} aria-label={`${label}: column help`}>
      ⓘ
    </span>
  </Popover>
);
