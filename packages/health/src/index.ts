import type { BotId, HealthReport, HealthStatus } from '@polymarket-bot/contracts';
import type { Logger } from '@polymarket-bot/logger';

export type ReadinessProbe = () => Promise<boolean> | boolean;

export interface HealthServerOptions {
  botId: BotId;
  port: number;
  logger: Logger;
  /**
   * Probes that must ALL return true for /readyz to return 200.
   * Examples: redis ping, websocket connected, RPC reachable.
   */
  readinessProbes?: Record<string, ReadinessProbe>;
  /** Optional async hook to enrich the /healthz payload with custom details. */
  details?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}

export interface HealthServer {
  url: string;
  stop: () => Promise<void>;
  buildReport: () => Promise<HealthReport>;
}

/**
 * Lightweight HTTP health server using Bun.serve. Exposes:
 *   GET /healthz  -> 200 + HealthReport JSON when service is alive
 *   GET /readyz   -> 200 only when all readiness probes pass
 *
 * Designed to be embedded in every bot (Plans 2-5) and the dashboard
 * gateway (Plan 6). Used by Docker healthchecks and (later) AWS ALB
 * target group health.
 */
export const startHealthServer = async (opts: HealthServerOptions): Promise<HealthServer> => {
  const startedAt = Date.now();
  const probes = opts.readinessProbes ?? {};

  const buildReport = async (): Promise<HealthReport> => {
    const probeResults: Record<string, boolean> = {};
    let anyDown = false;
    for (const [name, probe] of Object.entries(probes)) {
      try {
        const ok = await probe();
        probeResults[name] = ok;
        if (!ok) anyDown = true;
      } catch (err) {
        probeResults[name] = false;
        anyDown = true;
        opts.logger.warn({ err, probe: name }, 'health.probe.error');
      }
    }
    const status: HealthStatus = anyDown ? 'DEGRADED' : 'UP';
    const extra = opts.details ? await opts.details() : {};
    return {
      botId: opts.botId,
      status,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      details: { probes: probeResults, ...extra },
      timestamp: Date.now(),
    };
  };

  const checkReadiness = async (): Promise<boolean> => {
    if (Object.keys(probes).length === 0) return true;
    for (const probe of Object.values(probes)) {
      try {
        if (!(await probe())) return false;
      } catch {
        return false;
      }
    }
    return true;
  };

  // Bun.serve is the runtime API; falls back to a no-op when running under
  // node-only tools (e.g. tsc, eslint).
  const bunGlobal = (
    globalThis as { Bun?: { serve: (cfg: unknown) => { stop: () => void; url: URL } } }
  ).Bun;
  if (!bunGlobal) {
    opts.logger.warn({ port: opts.port }, 'health.bun.unavailable');
    return {
      url: `http://localhost:${opts.port}`,
      stop: async () => undefined,
      buildReport,
    };
  }

  const server = bunGlobal.serve({
    port: opts.port,
    fetch: async (req: Request): Promise<Response> => {
      const { pathname } = new URL(req.url);
      if (pathname === '/healthz') {
        const report = await buildReport();
        return new Response(JSON.stringify(report), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (pathname === '/readyz') {
        const ready = await checkReadiness();
        return new Response(ready ? 'ready' : 'not-ready', { status: ready ? 200 : 503 });
      }
      return new Response('not found', { status: 404 });
    },
  });

  opts.logger.info({ port: opts.port, botId: opts.botId }, 'health.server.started');

  return {
    url: server.url.toString(),
    stop: async () => server.stop(),
    buildReport,
  };
};
