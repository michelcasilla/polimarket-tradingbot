import { Popover, Space, Typography } from 'antd';
import type { MarketMetadataView } from '../metadata';
import { truncateId } from '../market';
import { MarketFichaContent } from './MarketFichaContent';

const { Text } = Typography;

export interface MarketLineWithFichaProps {
  marketId: string;
  meta: MarketMetadataView | undefined;
  /** Polymarket event URL when slug is known */
  polymarketHref?: string | null;
  /** Primary label uses Typography strong */
  textStrong?: boolean;
  maxLabelWidth?: number;
}

export const MarketLineWithFicha = ({
  marketId,
  meta,
  polymarketHref = null,
  textStrong = true,
  maxLabelWidth = 300,
}: MarketLineWithFichaProps) => {
  const lineLabel = meta?.question ?? truncateId(marketId);
  const labelEl =
    polymarketHref ? (
      <a
        href={polymarketHref}
        target="_blank"
        rel="noreferrer"
        className="market-link"
        style={{ fontWeight: textStrong ? 600 : 500 }}
        onClick={(e) => e.stopPropagation()}
      >
        {lineLabel}
      </a>
    ) : (
      <Text
        strong={textStrong}
        style={{ display: 'block', maxWidth: maxLabelWidth }}
        ellipsis={{ tooltip: false }}
      >
        {lineLabel}
      </Text>
    );

  return (
    <Space size={6} align="center" wrap={false} className="market-line-with-ficha" style={{ maxWidth: '100%' }}>
      {labelEl}
      <Popover
        title="Market"
        content={<MarketFichaContent marketId={marketId} meta={meta} />}
        trigger="click"
        destroyTooltipOnHide
      >
        <span
          role="button"
          tabIndex={0}
          className="market-ficha-hint"
          aria-label="Open market details"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              (e.target as HTMLElement).click();
            }
          }}
        >
          ⓘ
        </span>
      </Popover>
    </Space>
  );
};
