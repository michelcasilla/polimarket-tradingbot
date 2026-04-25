import { describe, expect, test } from 'bun:test';
import {
  ExecutionOrderSchema,
  MarketSignalSchema,
  OracleSignalSchema,
  OrderBookSnapshotSchema,
  Channels,
  ChannelSchemas,
  bookSnapshotChannel,
  bookDeltaChannel,
} from '../index.js';

describe('contracts/schemas', () => {
  test('ExecutionOrder defaults to postOnly=true (Maker Rewards)', () => {
    const parsed = ExecutionOrderSchema.parse({
      id: 'ord_1',
      marketId: 'mkt_1',
      assetId: 'asset_1',
      outcome: 'YES',
      side: 'BUY',
      price: 0.49,
      size: 10,
      createdAt: Date.now(),
    });
    expect(parsed.postOnly).toBe(true);
    expect(parsed.type).toBe('LIMIT');
    expect(parsed.timeInForce).toBe('GTC');
  });

  test('MarketSignal rejects fairPrice out of range', () => {
    const result = MarketSignalSchema.safeParse({
      marketId: 'mkt',
      outcome: 'YES',
      fairPrice: 1.2,
      confidence: 0.9,
      reason: 'SPREAD_CAPTURE',
      ttlMs: 1000,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  test('OracleSignal validates impactScore [0,1]', () => {
    const ok = OracleSignalSchema.safeParse({
      id: 'sig_1',
      provider: 'BINANCE',
      eventType: 'PRICE_DELTA',
      impactScore: 0.5,
      topic: 'BTCUSDT',
      timestamp: Date.now(),
      rawData: { price: 70000 },
    });
    expect(ok.success).toBe(true);
  });

  test('OrderBookSnapshot accepts empty bids/asks with null mid', () => {
    const parsed = OrderBookSnapshotSchema.parse({
      marketId: 'mkt',
      assetId: 'asset',
      outcome: 'NO',
      bids: [],
      asks: [],
      midPrice: null,
      spread: null,
      timestamp: Date.now(),
      sequence: 0,
    });
    expect(parsed.bids).toHaveLength(0);
  });
});

describe('contracts/channels', () => {
  test('every static channel has a schema', () => {
    for (const channel of Object.values(Channels)) {
      expect(ChannelSchemas[channel]).toBeDefined();
    }
  });

  test('parameterised channels build correctly', () => {
    expect(bookSnapshotChannel('mkt_42')).toBe('polymarket:book:snapshot:mkt_42');
    expect(bookDeltaChannel('mkt_42')).toBe('polymarket:book:delta:mkt_42');
  });
});
