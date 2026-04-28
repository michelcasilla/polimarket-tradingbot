import { argv } from 'node:process';
import { replaySnapshots } from './replayer.js';

const getArg = (name: string): string | null => {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] ?? null;
};

const main = async () => {
  const file = getArg('--file');
  if (!file) {
    console.error('Usage: bun run src/cli.ts --file <snapshots.ndjson>');
    process.exit(1);
  }
  const stats = await replaySnapshots(file, async () => undefined);
  console.log(JSON.stringify(stats, null, 2));
};

void main();
