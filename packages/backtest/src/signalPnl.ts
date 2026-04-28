import { readFile } from 'node:fs/promises';

type Scenario = {
  fillRate: number;
  spreadCaptureRate: number;
  roundTripFeeProb: number;
  adverseSelectionProb: number;
};

type ParsedSignal = {
  time: string;
  reason: string;
  spread: number | null;
};

const getArg = (name: string): string | null => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
};

const parseSignalFromLine = (line: string): ParsedSignal | null => {
  const jsonIdx = line.indexOf('{"level"');
  if (jsonIdx < 0) return null;
  try {
    const row = JSON.parse(line.slice(jsonIdx)) as Record<string, unknown>;
    if (row.msg !== 'strategist.signal.emitted') return null;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const spread =
      typeof metadata.spread === 'number'
        ? metadata.spread
        : typeof metadata.sActualSpread === 'number'
          ? metadata.sActualSpread
          : null;
    return {
      time: String(row.time ?? ''),
      reason: String(row.reason ?? 'UNKNOWN'),
      spread,
    };
  } catch {
    return null;
  }
};

const mean = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  return xs.reduce((acc, x) => acc + x, 0) / xs.length;
};

const main = async (): Promise<void> => {
  const file = getArg('--file');
  if (!file) {
    console.error(
      'Usage: bun run src/signalPnl.ts --file <strategist.log> [--size-usdc 20]',
    );
    process.exit(1);
  }

  const sizeUsdc = Number(getArg('--size-usdc') ?? '20');
  if (!Number.isFinite(sizeUsdc) || sizeUsdc <= 0) {
    console.error('Invalid --size-usdc. Must be > 0.');
    process.exit(1);
  }

  const raw = await readFile(file, 'utf8');
  const signals = raw
    .split(/\r?\n/)
    .map(parseSignalFromLine)
    .filter((x): x is ParsedSignal => x !== null);

  if (signals.length === 0) {
    console.error('No strategist signals found in file.');
    process.exit(1);
  }

  const spreadSignals = signals.filter(
    (s) => s.reason === 'SPREAD_CAPTURE' || s.reason === 'MAKER_REWARDS',
  );
  const spreadValues = spreadSignals
    .map((s) => s.spread)
    .filter((s): s is number => typeof s === 'number');

  const ts = signals
    .map((s) => Date.parse(s.time))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  const durationSec = ts.length > 1 ? (ts[ts.length - 1]! - ts[0]!) / 1000 : 1;
  const signalsPerHour = spreadSignals.length * (3600 / Math.max(1, durationSec));
  const avgSpread = mean(spreadValues);

  const byReason = Object.groupBy(signals, (s) => s.reason);
  const reasonStats = Object.fromEntries(
    Object.entries(byReason).map(([reason, rows]) => {
      const spreads = (rows ?? [])
        .map((r) => r.spread)
        .filter((s): s is number => typeof s === 'number');
      return [
        reason,
        {
          count: rows?.length ?? 0,
          avgSpread: spreads.length > 0 ? mean(spreads) : null,
        },
      ];
    }),
  );

  const scenarios: Record<string, Scenario> = {
    conservative: {
      fillRate: 0.18,
      spreadCaptureRate: 0.45,
      roundTripFeeProb: 0.002,
      adverseSelectionProb: 0.008,
    },
    base: {
      fillRate: 0.28,
      spreadCaptureRate: 0.6,
      roundTripFeeProb: 0.002,
      adverseSelectionProb: 0.004,
    },
    optimistic: {
      fillRate: 0.4,
      spreadCaptureRate: 0.75,
      roundTripFeeProb: 0.0015,
      adverseSelectionProb: 0.002,
    },
  };

  const scenarioStats = Object.fromEntries(
    Object.entries(scenarios).map(([name, s]) => {
      const edgeProb =
        avgSpread * s.spreadCaptureRate -
        s.roundTripFeeProb -
        s.adverseSelectionProb;
      const pnlPerSignalUsdc = sizeUsdc * s.fillRate * edgeProb;
      const pnlPerHourUsdc = pnlPerSignalUsdc * signalsPerHour;
      return [
        name,
        {
          ...s,
          edgeProb,
          pnlPerSignalUsdc,
          pnlPerHourUsdc,
          pnlPerDayUsdc: pnlPerHourUsdc * 24,
        },
      ];
    }),
  );

  const out = {
    sample: {
      sizeUsdc,
      totalSignals: signals.length,
      spreadSignals: spreadSignals.length,
      durationSec,
      signalsPerHour,
      avgSpread,
    },
    reasons: reasonStats,
    scenarios: scenarioStats,
  };

  console.log(JSON.stringify(out, null, 2));
};

void main();
