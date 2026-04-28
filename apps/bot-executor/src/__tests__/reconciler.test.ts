import { describe, expect, mock, test } from 'bun:test';
import { createReconciler } from '../reconciler';
import { Channels } from '@polymarket-bot/contracts';

describe('reconciler', () => {
  test('publishes reconciliation event', async () => {
    const publish = mock(async () => 1);
    const bus = { publish } as unknown as {
      publish: (channel: string, payload: unknown) => Promise<number>;
    };
    const liveAdapter = {
      getClobClient: () => ({
        getOpenOrders: async () => [{ orderID: 'ord_a' }],
      }),
    } as unknown as Parameters<typeof createReconciler>[0]['liveAdapter'];

    const reconciler = createReconciler({
      intervalMs: 10_000,
      bus: bus as never,
      logger: { warn: () => undefined } as never,
      liveAdapter,
      getLocalOpenOrderIds: () => ['ord_a'],
    });

    reconciler.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    reconciler.stop();

    expect(publish.mock.calls.length).toBeGreaterThan(0);
    const firstCall = publish.mock.calls[0] as unknown as [string, unknown];
    expect(firstCall[0]).toBe(Channels.executorReconciliation);
  });
});
