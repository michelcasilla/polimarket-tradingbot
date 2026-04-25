import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { CommonEnvSchema, RiskEnvSchema, loadEnv } from '../index.js';

describe('config/loadEnv', () => {
  test('applies defaults for CommonEnv', () => {
    const cfg = loadEnv(CommonEnvSchema, {});
    expect(cfg.NODE_ENV).toBe('development');
    expect(cfg.LOG_LEVEL).toBe('info');
    expect(cfg.REDIS_URL).toBe('redis://localhost:6379');
  });

  test('coerces numeric env vars in RiskEnv', () => {
    const cfg = loadEnv(RiskEnvSchema, {
      MAX_CAPITAL_PER_TRADE_USDC: '25.5',
      DAILY_STOP_LOSS_USDC: '0',
      MAX_INVENTORY_PERCENT: '7',
      MIN_GAS_BALANCE_MATIC: '2.5',
    });
    expect(cfg.MAX_CAPITAL_PER_TRADE_USDC).toBe(25.5);
    expect(cfg.MAX_INVENTORY_PERCENT).toBe(7);
  });

  test('throws with field summary on invalid input', () => {
    const schema = z.object({ FOO: z.string().min(3) });
    expect(() => loadEnv(schema, { FOO: 'a' })).toThrow(/FOO/);
  });
});
