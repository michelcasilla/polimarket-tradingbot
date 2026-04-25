import { pino, type LoggerOptions } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CreateLoggerOptions {
  /** Bot identifier, e.g. "oracle", "tape-reader". */
  service: string;
  level?: LogLevel;
  /**
   * Hint accepted for API symmetry with the docs. We DO NOT activate pino's
   * transport worker because it is unreliable under Bun (worker threads cannot
   * resolve `pino-pretty` via the bun loader). Pipe stdout through
   * `bunx pino-pretty` in dev instead:
   *
   *   bun run dev | bunx pino-pretty
   */
  pretty?: boolean;
}

/**
 * Fields that must NEVER appear in plaintext logs. Adapted to the project:
 *  - Polygon private keys / mnemonics
 *  - API keys (Sportradar, NewsAPI, Twitter)
 *  - Authorization headers
 */
const REDACTED_PATHS = [
  'privateKey',
  'PRIVATE_KEY',
  'POLYGON_PRIVATE_KEY',
  'mnemonic',
  'apiKey',
  'API_KEY',
  'SPORTRADAR_API_KEY',
  'NEWS_API_KEY',
  'TWITTER_BEARER_TOKEN',
  'authorization',
  'Authorization',
  'cookie',
  '*.privateKey',
  '*.PRIVATE_KEY',
  '*.apiKey',
  '*.authorization',
  'headers.authorization',
  'headers.cookie',
];

export const createLogger = (opts: CreateLoggerOptions) => {
  void opts.pretty;
  const base: LoggerOptions = {
    level: opts.level ?? 'info',
    base: { service: opts.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACTED_PATHS,
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
  return pino(base);
};

export type Logger = ReturnType<typeof createLogger>;
