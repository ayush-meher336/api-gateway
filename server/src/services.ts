import type { Db } from './db/client.js';
import { createRepos, type Repos } from './db/repos/index.js';
import { SnapshotStore } from './router/snapshot.js';
import { KeyLimiter } from './router/limiter.js';
import { RATE_LIMIT_DEFAULTS, RateLimitTracker } from './router/rateLimits.js';
import { RouterState } from './router/strategies.js';
import { LogWriter } from './logging/logWriter.js';
import { UsageCache } from './logging/usageCache.js';
import type { FetchFn } from './adapters/types.js';
import type { KeyStatus, UpstreamKey } from './db/types.js';

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Everything the HTTP layer needs, wired once per process (or per test). */
export function createServices(db: Db, masterKey: Buffer, opts: { fetchFn?: FetchFn; logger?: Logger } = {}) {
  const repos: Repos = createRepos(db, masterKey);
  const logger = opts.logger ?? silent;
  const snapshots = new SnapshotStore(repos);
  const router = new RouterState(repos.settings.get<Record<string, number>>('rrCursors', {}));
  const services = {
    db,
    masterKey,
    repos,
    logger,
    snapshots,
    router,
    limiter: new KeyLimiter(),
    // shares RATE_LIMIT_DEFAULTS so Settings changes apply live
    rateLimits: new RateLimitTracker(RATE_LIMIT_DEFAULTS),
    usage: new UsageCache(db),
    logWriter: new LogWriter(db, logger),
    fetchFn: opts.fetchFn ?? ((url, init) => fetch(url, init as RequestInit)),
    startedAt: Date.now(),
    /** Persist an upstream key status change and mirror it in the live snapshot. */
    setKeyStatus(id: number, status: KeyStatus, extra: Partial<Pick<UpstreamKey, 'cooldownUntil' | 'lastError' | 'failStreak'>> = {}) {
      repos.upstreamKeys.setStatus(id, status, extra);
      snapshots.updateKey(id, { status, ...extra });
    },
    persistCursors() {
      repos.settings.set('rrCursors', router.exportCursors());
    },
  } satisfies Record<string, unknown> & { fetchFn: FetchFn };
  return services;
}

export type Services = ReturnType<typeof createServices>;
