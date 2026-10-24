import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { KpiTile, PALETTE, TimeSeriesChart } from '../components/charts';
import { TimeRangePicker, useRange } from '../components/TimeRangePicker';
import { Button, Card, Field, PageHeader, Select, T } from '../components/ui';
import { qs } from '../lib/api';
import { fmtMetric, fmtMs, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { useSummary, useTimeseries } from '../lib/queries';
import { GROUP_LABELS, METRIC_LABELS, type GroupBy, type Metric } from '../lib/types';

const RATIO = new Set<Metric>(['avgLatencyMs', 'cacheHitRatio', 'errorRate']);

export function Analytics() {
  const rs = useRange('7d');
  const [metric, setMetric] = useState<Metric>('totalTokens');
  const [groupBy, setGroupBy] = useState<GroupBy>('provider');
  const ts = useTimeseries(rs.range, metric, groupBy);
  const summary = useSummary(rs.range);
  const s = summary.data;

  // Per-series totals for the table (ratio metrics are averaged over non-empty buckets).
  const table = useMemo(() => {
    const series = ts.data?.series ?? [];
    const rows = series.map((x) => {
      const vals = x.points.map((p) => p.v);
      const nonzero = vals.filter((v) => v > 0);
      const value = RATIO.has(metric) ? (nonzero.length ? nonzero.reduce((a, b) => a + b, 0) / nonzero.length : 0) : vals.reduce((a, b) => a + b, 0);
      return { key: x.key, label: x.label, value };
    });
    const total = RATIO.has(metric) ? null : rows.reduce((a, r) => a + r.value, 0);
    return { rows, total };
  }, [ts.data, metric]);

  const csvHref = `/admin/api/analytics/export.csv${qs({ ...rs.range, groupBy })}`;

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Slice any metric by any dimension over any time range."
        actions={
          <>
            <TimeRangePicker state={rs} />
            <a href={csvHref} download><Button icon={<Download className="size-4" />}>Export CSV</Button></a>
          </>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiTile label="Requests" value={fmtNum(s?.requests)} />
        <KpiTile label="Errors" value={fmtNum(s?.errors)} sub={fmtPct(s?.errorRate)} />
        <KpiTile label="Input tokens" value={fmtNum(s?.inputTokens)} />
        <KpiTile label="Output tokens" value={fmtNum(s?.outputTokens)} />
        <KpiTile label="Cached / cache write" value={fmtNum(s?.cachedReadTokens)} sub={s ? `${fmtNum(s.cacheWriteTokens)} written` : undefined} />
        <KpiTile label="Reasoning tokens" value={fmtNum(s?.reasoningTokens)} />
        <KpiTile label="Cost" value={fmtUsd(s?.costUsd)} />
        <KpiTile label="p50 / p95 / p99" value={fmtMs(s?.p50LatencyMs)} sub={`${fmtMs(s?.p95LatencyMs)} · ${fmtMs(s?.p99LatencyMs)}`} />
      </div>
      <Card
        className="mb-6"
        title={`${METRIC_LABELS[metric]} by ${GROUP_LABELS[groupBy].toLowerCase()}`}
        actions={
          <div className="flex gap-2">
            <Field label={<span className="sr-only">Metric</span>}>
              <Select className="h-8 w-auto text-[13px]" value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
                {Object.entries(METRIC_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label={<span className="sr-only">Group by</span>}>
              <Select className="h-8 w-auto text-[13px]" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                {Object.entries(GROUP_LABELS).map(([k, v]) => <option key={k} value={k}>{k === 'none' ? 'No grouping' : `By ${v.toLowerCase()}`}</option>)}
              </Select>
            </Field>
          </div>
        }
      >
        <TimeSeriesChart data={ts.data} metric={metric} height={360} loading={ts.isLoading} maxSeries={10} />
        {ts.data && <p className="mt-2 text-right text-xs text-muted">{ts.data.bucket === 'hour' ? 'Hourly' : 'Daily'} buckets</p>}
      </Card>
      <Card pad={false} title="Breakdown">
        <div className={T.wrap}>
          <table className={T.table}>
            <thead>
              <tr>
                <th className={T.th}>{GROUP_LABELS[groupBy]}</th>
                <th className={`${T.th} text-right`}>{METRIC_LABELS[metric]}</th>
                {table.total != null && <th className={`${T.th} w-1/3`}>Share</th>}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={r.key} className={T.row}>
                  <td className={T.td}>
                    <span className="mr-2 inline-block size-2.5 rounded-full" style={{ background: PALETTE[i % PALETTE.length] }} />
                    {r.label}
                  </td>
                  <td className={`${T.td} tabular text-right font-medium`}>{fmtMetric(metric, r.value)}</td>
                  {table.total != null && (
                    <td className={T.td}>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <div className="h-full rounded-full" style={{ width: `${table.total ? (r.value / table.total) * 100 : 0}%`, background: PALETTE[i % PALETTE.length] }} />
                        </div>
                        <span className="tabular w-10 text-right text-xs text-muted">{table.total ? fmtPct(r.value / table.total) : '—'}</span>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
              {!table.rows.length && (
                <tr><td className={`${T.td} py-8 text-center text-muted`} colSpan={3}>No traffic in this range</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
