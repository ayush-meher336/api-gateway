import type { Db } from '../db/client.js';

const TTL_MS = 10_000;
const DAY = 86_400_000;

export const startOfUtcDay = (now: number) => Math.floor(now / DAY) * DAY;
export const startOfUtcMonth = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

export interface GatewaySpend {
  dayUsd: number;
  monthUsd: number;
  totalTokens: number;
}

/** Short-lived cache over usage rollups for budget, quota and daily-cap checks. */
export class UsageCache {
  private cache = new Map<string, { at: number; value: any }>();
  constructor(private db: Db) {}

  private memo<T>(key: string, fn: () => T): T {
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < TTL_MS) return hit.value as T;
    const value = fn();
    this.cache.set(key, { at: now, value });
    return value;
  }

  clear(): void {
    this.cache.clear();
  }

  gatewaySpend(gkId: number, now = Date.now()): GatewaySpend {
    return this.memo(`gw:${gkId}`, () => {
      const row = this.db
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN bucket_start >= ? THEN cost_usd END), 0) AS day_usd,
             COALESCE(SUM(CASE WHEN bucket_start >= ? THEN cost_usd END), 0) AS month_usd,
             COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens
           FROM usage_rollups WHERE bucket = 'day' AND gateway_key_id = ?`,
        )
        .get(startOfUtcDay(now), startOfUtcMonth(now), gkId) as any;
      return { dayUsd: row.day_usd, monthUsd: row.month_usd, totalTokens: row.total_tokens };
    });
  }

  upstreamDaily(keyId: number, now = Date.now()): { requests: number; tokens: number } {
    return this.memo(`up:${keyId}`, () => {
      const row = this.db
        .prepare(
          `SELECT COALESCE(SUM(requests),0) r, COALESCE(SUM(input_tokens + output_tokens),0) t
           FROM usage_rollups WHERE bucket = 'day' AND bucket_start = ? AND upstream_key_id = ?`,
        )
        .get(startOfUtcDay(now), keyId) as any;
      return { requests: row.r, tokens: row.t };
    });
  }
}
