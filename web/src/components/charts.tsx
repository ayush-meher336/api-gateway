import { useMemo, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtMetric, fmtNum } from '../lib/format';
import type { Timeseries } from '../lib/types';
import { cx, Spinner } from './ui';

export const PALETTE = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#22c55e', '#0ea5e9', '#a855f7', '#ef4444', '#84cc16', '#f97316'];

export function KpiTile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'ok' | 'warn' | 'err' }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={cx('tabular mt-1 text-2xl font-semibold tracking-tight', tone === 'err' && 'text-err', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')}>{value}</div>
      {sub && <div className="tabular mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Hours for ranges within a day, "Oct 21 14:00" for multi-day hourly, dates for daily buckets. */
const tick = (data: Timeseries) => (t: number) => {
  const d = new Date(t);
  if (data.bucket === 'day') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return data.to - data.from > 86_400_000 ? `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}` : time;
};

/** Stacked area chart of a timeseries response (one area per series). */
export function TimeSeriesChart({ data, metric, height = 260, maxSeries = 8, loading }: { data?: Timeseries; metric: string; height?: number; maxSeries?: number; loading?: boolean }) {
  const { rows, series } = useMemo(() => {
    if (!data) return { rows: [], series: [] };
    const top = data.series.slice(0, maxSeries);
    const rest = data.series.slice(maxSeries);
    const series = rest.length ? [...top, { key: '__other', label: `Other (${rest.length})`, points: data.buckets.map((t, i) => ({ t, v: rest.reduce((s, r) => s + (r.points[i]?.v ?? 0), 0) })) }] : top;
    const rows = data.buckets.map((t, i) => {
      const row: Record<string, number> = { t };
      for (const s of series) row[s.key] = s.points[i]?.v ?? 0;
      return row;
    });
    return { rows, series };
  }, [data, maxSeries]);

  if (!data) return <div className="grid place-items-center" style={{ height }}>{loading ? <Spinner /> : null}</div>;
  if (!series.length) return <div className="grid place-items-center text-sm text-muted" style={{ height }}>No traffic in this range yet</div>;
  const stack = !['avgLatencyMs', 'cacheHitRatio', 'errorRate'].includes(metric);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="t" tickFormatter={tick(data)} stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis stroke="var(--muted)" fontSize={11} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => (metric === 'costUsd' ? `$${fmtNum(v)}` : fmtMetric(metric, v))} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--fg)' }}
          labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
          formatter={(v: number, name: string) => [fmtMetric(metric, v), series.find((s) => s.key === name)?.label ?? name]}
        />
        {series.length > 1 && <Legend formatter={(k) => <span className="text-xs text-muted">{series.find((s) => s.key === k)?.label ?? k}</span>} iconType="circle" iconSize={8} />}
        {series.map((s, i) => (
          <Area key={s.key} type="monotone" dataKey={s.key} stackId={stack ? '1' : undefined} stroke={PALETTE[i % PALETTE.length]} strokeWidth={1.75} fill={`url(#g-${s.key})`} isAnimationActive={false} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TopList({ rows, metric, empty = 'No data' }: { rows?: { key: string; label: string; value: number }[]; metric: string; empty?: string }) {
  if (!rows) return <div className="grid h-32 place-items-center"><Spinner /></div>;
  if (!rows.length) return <div className="py-8 text-center text-sm text-muted">{empty}</div>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={r.key}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate" title={r.label}>{r.label}</span>
            <span className="tabular shrink-0 font-medium">{fmtMetric(metric, r.value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Progress({ value, max, label }: { value: number; max: number; label: ReactNode }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-muted">
        <span>{label}</span>
        <span className="tabular">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div className={cx('h-full rounded-full transition-all', pct >= 100 ? 'bg-err' : pct >= 80 ? 'bg-warn' : 'bg-accent')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
