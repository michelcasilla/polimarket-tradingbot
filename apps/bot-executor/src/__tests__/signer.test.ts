import { describe, expect, test } from 'bun:test';
import { privateKeyToAccount } from 'viem/accounts';
import { createPolymarketSigner } from '../signer';

describe('signer', () => {
  test('derives signer address from private key', () => {
    const pk = '0x59c6995e998f97a5a0044966f0945382d7d0d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
    const expected = privateKeyToAccount(pk).address;
    const signer = createPolymarketSigner({
      privateKey: pk,
      proxyWallet: '0x1111111111111111111111111111111111111111',
      signatureType: 2,
      chainId: 137,
      host: 'https://clob.polymarket.com',
      rpcUrl: 'https://polygon-rpc.com',
    });
    expect(signer.accountAddress).toBe(expected);
  });
});
