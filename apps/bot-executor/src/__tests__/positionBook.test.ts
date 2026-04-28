import { describe, expect, test } from 'bun:test';
import { createPositionBook } from '../positionBook';

describe('positionBook', () => {
  test('updates net size after fills', async () => {
    const book = createPositionBook({ redisUrl: 'redis://localhost:6379' });
    const buy = await book.applyFill({
      id: 'fill_1',
      orderId: 'ord_1',
      signalId: 'sig_1',
      marketId: 'mkt_1',
      outcome: 'YES',
      side: 'BUY',
      size: 10,
      price: 0.5,
      feesUsdc: 0.1,
      isMaker: true,
      timestamp: Date.now(),
    });
    expect(buy.netSize).toBe(10);

    const sell = await book.applyFill({
      id: 'fill_2',
      orderId: 'ord_2',
      signalId: 'sig_2',
      marketId: 'mkt_1',
      outcome: 'YES',
      side: 'SELL',
      size: 4,
      price: 0.6,
      feesUsdc: 0.1,
      isMaker: true,
      timestamp: Date.now() + 10,
    });
    expect(sell.netSize).toBe(6);
    expect(sell.realizedPnlUsdc).toBeLessThan(0);
    await book.shutdown();
  });
});
