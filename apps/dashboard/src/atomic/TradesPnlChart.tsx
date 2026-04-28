import { useMemo } from 'react';
import Highcharts from 'highcharts';
import HighchartsReact from 'highcharts-react-official';
import type { ExecutionResultView } from '../execution';
import { computeLivePnlUsdc } from '../execution';
import type { MarketSnapshot } from '../market';

export interface TradesPnlChartProps {
  trades: ExecutionResultView[];
  snapshots: MarketSnapshot[];
}

export const TradesPnlChart = ({ trades, snapshots }: TradesPnlChartProps) => {
  const series = useMemo(() => {
    let cumulative = 0;
    return [...trades]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((trade) => {
        const pnl = computeLivePnlUsdc(trade, snapshots) ?? 0;
        cumulative += pnl;
        return [trade.timestamp, Number(cumulative.toFixed(6))] as [number, number];
      });
  }, [trades, snapshots]);

  const options = useMemo<Highcharts.Options>(
    () => ({
      chart: {
        type: 'spline',
        backgroundColor: 'transparent',
        height: 280,
      },
      title: { text: '' },
      credits: { enabled: false },
      legend: { enabled: false },
      xAxis: {
        type: 'datetime',
        labels: { style: { color: '#d8dee9' } },
        lineColor: 'rgba(145,202,255,0.2)',
      },
      yAxis: {
        title: { text: 'Cumulative PnL (USDC)', style: { color: '#d8dee9' } },
        labels: { style: { color: '#d8dee9' } },
        gridLineColor: 'rgba(145,202,255,0.12)',
      },
      tooltip: {
        xDateFormat: '%H:%M:%S',
        pointFormat: '<b>{point.y:.4f} USDC</b>',
      },
      plotOptions: {
        series: {
          marker: { enabled: false },
          lineWidth: 2.5,
        },
      },
      series: [
        {
          type: 'spline',
          name: 'PnL',
          data: series,
          color: '#61dafb',
        },
      ],
    }),
    [series],
  );

  return <HighchartsReact highcharts={Highcharts} options={options} />;
};
