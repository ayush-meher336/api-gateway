import type { Db } from '../db/client.js';
import type { Repos } from '../db/repos/index.js';
import type { DimCol } from './stats.js';

export type GroupBy = 'none' | 'gatewayKey' | 'upstreamKey' | 'provider' | 'model';
export type Metric =
  | 'requests' | 'errors' | 'inputTokens' | 'outputTokens' | 'cachedReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'
  | 'totalTokens' | 'costUsd' | 'avgLatencyMs' | 'cacheHitRatio' | 'errorRate';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const GROUP_COL: Record<Exclude<GroupBy, 'none'>, DimCol> = {
  gatewayKey: 'gateway_key_id',
  upstreamKey: 'upstream_key_id',
  provider: 'provider_id',
  model: 'model_id',
};

export interface Agg {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  latencySumMs: number;
}

const SUMS = `SUM(requests) requests, SUM(errors) errors, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens,
  SUM(cached_read_tokens) cachedReadTokens, SUM(cache_write_tokens) cacheWriteTokens, SUM(reasoning_tokens) reasoningTokens,
  SUM(cost_usd) costUsd, SUM(latency_sum_ms) latencySumMs`;

export function metricValue(a: Agg, m: Metric): number {
  switch (m) {
    case 'totalTokens':
      return a.inputTokens + a.outputTokens;
    case 'avgLatencyMs':
      return a.requests ? a.latencySumMs / a.requests : 0;
    case 'cacheHitRatio':
      return a.inputTokens ? a.cachedReadTokens / a.inputTokens : 0;
    case 'errorRate':
      return a.requests ? a.errors / a.requests : 0;
    default:
      return a[m] ?? 0;
  }
}

export function resolveRange(q: { from?: number; to?: number }, now = Date.now()) {
  const to = q.to ?? now;
  const from = q.from ?? to - DAY;
  const bucket: 'hour' | 'day' = to - from <= 7 * DAY ? 'hour' : 'day';
  const size = bucket === 'hour' ? HOUR : DAY;
  return { from, to, bucket, size, start: Math.floor(from / size) * size };
}

/** Human labels for dimension ids. */
export function labeler(repos: Repos, groupBy: GroupBy): (id: number) => string {
  if (groupBy === 'none') return () => 'all';
  const maps: Record<Exclude<GroupBy, 'none'>, () => Map<number, string>> = {
    gatewayKey: () => new Map(repos.gatewayKeys.list().map((k) => [k.id, k.name])),
    upstreamKey: () => {
      const providers = new Map(repos.providers.list().map((p) => [p.id, p.name]));
      return new Map(repos.upstreamKeys.list().map((k) => [k.id, `${providers.get(k.providerId) ?? '?'} · ${k.label}`]));
    },
    provider: () => new Map(repos.providers.list().map((p) => [p.id, p.name])),
    model: () => {
      const providers = new Map(repos.providers.list().map((p) => [p.id, p.name]));
      return new Map(repos.models.list().map((m) => [m.id, `${providers.get(m.providerId) ?? '?'}/${m.upstreamModelId}`]));
    },
  };
  const map = maps[groupBy]();
  return (id) => (id === 0 ? '(none)' : (map.get(id) ?? `#${id} (deleted)`));
}

export function totals(db: Db, from: number, to: number, filter: { col: DimCol; id: number } | null = null): Agg {
  const start = Math.floor(from / HOUR) * HOUR;
  const where = filter ? `AND ${filter.col} = ?` : '';
  const row = db
    .prepare(`SELECT ${SUMS} FROM usage_rollups WHERE bucket = 'hour' AND bucket_start >= ? AND bucket_start <= ? ${where}`)
    .get(...(filter ? [start, to, filter.id] : [start, to])) as any;
  const out: any = {};
  for (const k of Object.keys(row)) out[k] = row[k] ?? 0;
  return out as Agg;
}

export function latencyPercentiles(db: Db, from: number, to: number, filter: { col: DimCol; id: number } | null = null) {
  const where = filter ? `AND ${filter.col} = ?` : '';
  const args = filter ? [from, to, filter.id] : [from, to];
  const n = (db.prepare(`SELECT count(*) c FROM request_logs WHERE ts >= ? AND ts <= ? AND latency_ms IS NOT NULL ${where}`).get(...args) as any).c as number;
  const at = (p: number) => {
    if (!n) return null;
    const offset = Math.max(0, Math.ceil(p * n) - 1);
    const row = db
      .prepare(`SELECT latency_ms v FROM request_logs WHERE ts >= ? AND ts <= ? AND latency_ms IS NOT NULL ${where} ORDER BY latency_ms LIMIT 1 OFFSET ?`)
      .get(...args, offset) as any;
    return row?.v ?? null;
  };
  return { p50LatencyMs: at(0.5), p95LatencyMs: at(0.95), p99LatencyMs: at(0.99) };
}

export interface Series {
  key: string;
  label: string;
  points: { t: number; v: number }[];
}

/** Bucketed rows per group with zero-filled gaps. */
export function timeseriesRows(db: Db, q: { from?: number; to?: number }, groupBy: GroupBy, filter: { col: DimCol; id: number } | null = null) {
  const r = resolveRange(q);
  const col = groupBy === 'none' ? '0' : GROUP_COL[groupBy];
  const where = filter ? `AND ${filter.col} = ?` : '';
  const rows = db
    .prepare(
      `SELECT bucket_start t, ${col} g, ${SUMS} FROM usage_rollups
       WHERE bucket = ? AND bucket_start >= ? AND bucket_start <= ? ${where}
       GROUP BY t, g ORDER BY t`,
    )
    .all(...(filter ? [r.bucket, r.start, r.to, filter.id] : [r.bucket, r.start, r.to])) as any[];
  const buckets: number[] = [];
  for (let t = r.start; t <= r.to; t += r.size) buckets.push(t);
  const groups = new Map<number, Map<number, Agg>>();
  for (const row of rows) {
    const g = Number(row.g);
    if (!groups.has(g)) groups.set(g, new Map());
    groups.get(g)!.set(row.t, row as Agg);
  }
  return { ...r, buckets, groups };
}

export function timeseries(db: Db, repos: Repos, q: { from?: number; to?: number }, metric: Metric, groupBy: GroupBy, filter: { col: DimCol; id: number } | null = null) {
  const { bucket, buckets, groups, from, to } = timeseriesRows(db, q, groupBy, filter);
  const label = labeler(repos, groupBy);
  const zero: Agg = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, latencySumMs: 0 };
  const series: Series[] = [...groups.entries()].map(([g, byT]) => ({
    key: String(g),
    label: label(g),
    points: buckets.map((t) => ({ t, v: metricValue(byT.get(t) ?? zero, metric) })),
  }));
  series.sort((a, b) => b.points.reduce((s, p) => s + p.v, 0) - a.points.reduce((s, p) => s + p.v, 0));
  return { bucket, from, to, metric, groupBy, buckets, series };
}

export function top(db: Db, repos: Repos, q: { from?: number; to?: number }, dimension: Exclude<GroupBy, 'none'>, metric: Metric, limit: number) {
  const r = resolveRange(q);
  const col = GROUP_COL[dimension];
  const rows = db
    .prepare(`SELECT ${col} g, ${SUMS} FROM usage_rollups WHERE bucket = 'hour' AND bucket_start >= ? AND bucket_start <= ? GROUP BY g`)
    .all(Math.floor(r.from / HOUR) * HOUR, r.to) as any[];
  const label = labeler(repos, dimension);
  return rows
    .map((row) => ({ key: String(row.g), label: label(Number(row.g)), value: metricValue(row as Agg, metric), requests: row.requests }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

export function toCsv(db: Db, repos: Repos, q: { from?: number; to?: number }, groupBy: GroupBy): string {
  const { buckets, groups } = timeseriesRows(db, q, groupBy);
  const label = labeler(repos, groupBy);
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ['bucket_start,group,requests,errors,input_tokens,output_tokens,cached_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,avg_latency_ms'];
  for (const t of buckets) {
    for (const [g, byT] of groups) {
      const a = byT.get(t);
      if (!a) continue;
      lines.push(
        [new Date(t).toISOString(), esc(label(g)), a.requests, a.errors, a.inputTokens, a.outputTokens, a.cachedReadTokens, a.cacheWriteTokens, a.reasoningTokens, a.costUsd.toFixed(6), metricValue(a, 'avgLatencyMs').toFixed(1)].join(','),
      );
    }
  }
  return lines.join('\n') + '\n';
}
