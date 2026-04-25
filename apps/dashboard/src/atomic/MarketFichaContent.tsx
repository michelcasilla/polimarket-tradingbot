import { Descriptions, Space, Tag, Typography } from 'antd';
import type { MarketMetadataView } from '../metadata';
import { truncateId } from '../market';

const { Link, Text } = Typography;

const polymarketEventUrl = (slug: string): string => `https://polymarket.com/event/${slug}`;

export interface MarketFichaContentProps {
  marketId: string;
  meta: MarketMetadataView | undefined;
}

export const MarketFichaContent = ({ marketId, meta }: MarketFichaContentProps) => {
  const href = meta?.slug ? polymarketEventUrl(meta.slug) : null;
  return (
    <div className="market-ficha" style={{ maxWidth: 380 }}>
      <Descriptions bordered size="small" column={1} labelStyle={{ width: 108 }}>
        <Descriptions.Item label="Question">
          <Text strong>{meta?.question ?? '—'}</Text>
        </Descriptions.Item>
        {meta?.category ? (
          <Descriptions.Item label="Series / ticker">
            <Tag color="purple">{meta.category}</Tag>
          </Descriptions.Item>
        ) : null}
        {meta?.slug ? (
          <Descriptions.Item label="Slug">
            {href ? (
              <Link href={href} target="_blank" rel="noreferrer">
                {meta.slug}
              </Link>
            ) : (
              <Text className="mono" copyable>
                {meta.slug}
              </Text>
            )}
          </Descriptions.Item>
        ) : null}
        <Descriptions.Item label="Condition ID">
          <Text className="mono" copyable style={{ fontSize: 11 }}>
            {marketId}
          </Text>
        </Descriptions.Item>
        {meta?.endDateIso ? (
          <Descriptions.Item label="End">
            <span className="mono">{meta.endDateIso}</span>
          </Descriptions.Item>
        ) : null}
        <Descriptions.Item label="Status">
          <Space size={4} wrap>
            <Tag color={meta?.active ? 'green' : 'default'}>{meta?.active !== false ? 'active' : 'inactive'}</Tag>
            <Tag color={meta?.closed ? 'red' : 'blue'}>{meta?.closed ? 'closed' : 'open'}</Tag>
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="Vol 24h">
          <span className="mono">
            {typeof meta?.volume24h === 'number'
              ? `$${meta.volume24h.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : '—'}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label="Liquidity">
          <span className="mono">
            {typeof meta?.liquidity === 'number'
              ? `$${meta.liquidity.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
              : '—'}
          </span>
        </Descriptions.Item>
      </Descriptions>
      {!meta ? (
        <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 11 }}>
          No metadata yet — open this card after a moment, or check that the condition id exists on Polymarket Gamma.
        </Text>
      ) : null}
      <Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 10 }}>
        Short id: {truncateId(marketId, 10, 10)}
      </Text>
    </div>
  );
};
