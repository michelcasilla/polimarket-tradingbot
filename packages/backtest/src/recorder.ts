import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OrderBookSnapshot } from '@polymarket-bot/contracts';

export interface SnapshotRecorder {
  recordSnapshot: (snapshot: OrderBookSnapshot) => Promise<void>;
}

export const createSnapshotRecorder = (filePath: string): SnapshotRecorder => {
  const ensureParent = async () => mkdir(dirname(filePath), { recursive: true });
  return {
    recordSnapshot: async (snapshot) => {
      await ensureParent();
      await appendFile(filePath, `${JSON.stringify(snapshot)}\n`, 'utf8');
    },
  };
};
