import { open } from 'node:fs/promises';
import type { OrderBookSnapshot } from '@polymarket-bot/contracts';

export interface ReplayStats {
  rowsRead: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

export const replaySnapshots = async (
  filePath: string,
  onSnapshot: (snapshot: OrderBookSnapshot) => Promise<void>,
): Promise<ReplayStats> => {
  const fd = await open(filePath, 'r');
  const rows = (await fd.readFile('utf8')).split('\n').filter(Boolean);
  await fd.close();
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  for (const row of rows) {
    const snap = JSON.parse(row) as OrderBookSnapshot;
    if (firstTimestamp === null) firstTimestamp = snap.timestamp;
    lastTimestamp = snap.timestamp;
    await onSnapshot(snap);
  }
  return { rowsRead: rows.length, firstTimestamp, lastTimestamp };
};
