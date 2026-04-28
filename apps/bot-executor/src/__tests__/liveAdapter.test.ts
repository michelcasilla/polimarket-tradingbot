import { describe, expect, test } from 'bun:test';
import { createLiveAdapter } from '../liveAdapter';

const baseOrder = {
  id: 'ord_1',
  marketId: 'mkt_1',
  assetId: 'asset_1',
  outcome: 'YES' as const,
  side: 'BUY' as const,
  price: 0.51,
  size: 10,
  type: 'LIMIT' as const,
  timeInForce: 'GTC' as const,
  postOnly: true,
  createdAt: Date.now(),
  signalReason: 'SPREAD_CAPTURE',
  signalId: 'sig_1',
};

describe('liveAdapter', () => {
  test('rejects invalid private key length', () => {
    expect(() =>
      createLiveAdapter({
        privateKey: 'short',
        proxyWallet: '0x1111111111111111111111111111111111111111',
        rpcUrl: 'https://polygon-rpc.com',
        chainId: 137,
        clobHttpUrl: 'https://clob.polymarket.com',
        redisUrl: 'redis://localhost:6379',
        dryRun: true,
        signatureType: 2,
      }),
    ).toThrow('privateKey rejected');
  });

  test('returns rejected order before init', async () => {
    const adapter = createLiveAdapter({
      privateKey: '0x59c6995e998f97a5a0044966f0945382d7d0d4d4d4d4d4d4d4d4d4d4d4d4d4d4',
      proxyWallet: '0x1111111111111111111111111111111111111111',
      rpcUrl: 'https://polygon-rpc.com',
      chainId: 137,
      clobHttpUrl: 'https://clob.polymarket.com',
      redisUrl: 'redis://localhost:6379',
      dryRun: true,
      signatureType: 2,
    });
    const result = await adapter.submit(baseOrder);
    expect(result.status).toBe('REJECTED');
    expect(result.error).toBe('live_adapter_not_initialized');
  });
});
