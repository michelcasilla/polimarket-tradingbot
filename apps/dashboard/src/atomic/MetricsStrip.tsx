import { Card, Col, Row, Statistic } from 'antd';
import type { UiMetric } from '../types';

export const MetricsStrip = ({ metrics }: { metrics: UiMetric[] }) => (
  <Row gutter={[8, 8]}>
    {metrics.map((metric) => (
      <Col key={metric.key} flex={1}>
        <Card className="compact-card metric-card" bodyStyle={{ padding: '4px 10px' }}>
          <Statistic
            title={metric.label}
            value={metric.value}
            valueStyle={{ fontSize: 16, lineHeight: 1.2 }}
          />
        </Card>
      </Col>
    ))}
  </Row>
);
