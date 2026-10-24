const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en');

export const fmtNum = (n: number | null | undefined) => (n == null ? '—' : Math.abs(n) >= 10_000 ? compact.format(n) : full.format(Math.round(n * 100) / 100));
export const fmtInt = (n: number | null | undefined) => (n == null ? '—' : full.format(Math.round(n)));

export function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 100) return `$${n.toFixed(2)}`;
  return `$${full.format(Math.round(n))}`;
}

export const fmtPct = (r: number | null | undefined) => (r == null ? '—' : `${(r * 100).toFixed(r < 0.1 && r > 0 ? 1 : 0)}%`);

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return 'never';
  const d = Math.round((now - ts) / 1000);
  if (d < 5) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function fmtIn(ts: number, now = Date.now()): string {
  const d = Math.max(0, Math.round((ts - now) / 1000));
  if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m ${d % 60}s`;
  return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
}

export const fmtDateTime = (ts: number | null | undefined) =>
  ts ? new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export function fmtMetric(metric: string, v: number): string {
  if (metric === 'costUsd') return fmtUsd(v);
  if (metric === 'avgLatencyMs') return fmtMs(v);
  if (metric === 'cacheHitRatio' || metric === 'errorRate') return fmtPct(v);
  return fmtNum(v);
}
