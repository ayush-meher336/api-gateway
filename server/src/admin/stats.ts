import type { Db } from '../db/client.js';

export type DimCol = 'gateway_key_id' | 'upstream_key_id' | 'provider_id' | 'model_id';

export interface QuickStats {
  requests: number;
  errors: number;
  tokens: number;
  costUsd: number;
}

const HOUR = 3_600_000;

/** Usage over the trailing 24h, keyed by one dimension, from hourly rollups. */
export function last24hBy(db: Db, col: DimCol, now = Date.now()): Map<number, QuickStats> {
  const rows = db
    .prepare(
      `SELECT ${col} id, SUM(requests) r, SUM(errors) e, SUM(input_tokens + output_tokens) t, SUM(cost_usd) c
       FROM usage_rollups WHERE bucket = 'hour' AND bucket_start >= ? GROUP BY ${col}`,
    )
    .all(Math.floor((now - 24 * HOUR) / HOUR) * HOUR) as any[];
  return new Map(rows.map((r) => [r.id, { requests: r.r, errors: r.e, tokens: r.t, costUsd: r.c }]));
}

export const emptyStats = (): QuickStats => ({ requests: 0, errors: 0, tokens: 0, costUsd: 0 });
