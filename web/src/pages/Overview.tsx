import { AlertTriangle, ArrowRight, CheckCircle2, Info, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { KpiTile, TimeSeriesChart, TopList } from '../components/charts';
import { TimeRangePicker, useRange } from '../components/TimeRangePicker';
import { Button, Card, cx, PageHeader, Tabs } from '../components/ui';
import { fmtMs, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { useAlerts, useGatewayKeys, useProviders, useSummary, useTimeseries, useTop } from '../lib/queries';
import type { Metric } from '../lib/types';

function GettingStarted() {
  const providers = useProviders();
  const gk = useGatewayKeys();
  const steps = [
    { done: !!providers.data?.length, label: 'Add a provider', to: '/providers' },
    { done: !!providers.data?.some((p) => p.keyCount > 0), label: 'Paste its API keys', to: '/keys' },
    { done: !!providers.data?.some((p) => p.modelCount > 0), label: 'Sync models (and optionally create aliases)', to: '/providers' },
    { done: !!gk.data?.length, label: 'Create a gateway key for your app', to: '/gateway-keys' },
  ];
  if (!providers.data || !gk.data || steps.every((s) => s.done)) return null;
  return (
    <Card className="mb-6" title="Get started">
      <ol className="grid gap-2 md:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.label}>
            <Link to={s.to} className={cx('flex h-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition hover:bg-surface-2', s.done ? 'border-ok/30' : 'border-border')}>
              {s.done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <span className="grid size-4 shrink-0 place-items-center rounded-full border border-border text-[10px] text-muted mt-0.5">{i + 1}</span>}
              <span className={s.done ? 'text-muted line-through' : ''}>{s.label}</span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function Overview() {
  const rs = useRange('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const summary = useSummary(rs.range);
  const ts = useTimeseries(rs.range, metric, 'provider');
  const topModels = useTop(rs.range, 'model', 'requests');
  const topGk = useTop(rs.range, 'gatewayKey', 'costUsd');
  const topKeys = useTop(rs.range, 'upstreamKey', 'requests', 8);
  const alerts = useAlerts();
  const s = summary.data;

  return (
    <>
      <PageHeader title="Overview" subtitle="Live traffic across every provider, key and model." actions={<TimeRangePicker state={rs} />} />
      <GettingStarted />
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiTile label="Requests" value={fmtNum(s?.requests)} />
        <KpiTile label="Error rate" value={fmtPct(s?.errorRate)} sub={s ? `${fmtNum(s.errors)} errors` : undefined} tone={s && s.errorRate > 0.05 ? 'err' : s && s.errorRate > 0.01 ? 'warn' : undefined} />
        <KpiTile label="Input tokens" value={fmtNum(s?.inputTokens)} />
        <KpiTile label="Output tokens" value={fmtNum(s?.outputTokens)} sub={s?.reasoningTokens ? `${fmtNum(s.reasoningTokens)} reasoning` : undefined} />
        <KpiTile label="Cached tokens" value={fmtNum(s?.cachedReadTokens)} sub={s ? `${fmtPct(s.cacheHitRatio)} of input` : undefined} />
        <KpiTile label="Cost" value={fmtUsd(s?.costUsd)} />
        <KpiTile label="Latency p50" value={fmtMs(s?.p50LatencyMs)} />
        <KpiTile label="Latency p95" value={fmtMs(s?.p95LatencyMs)} />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Traffic by provider"
          actions={<Tabs value={metric} onChange={setMetric} options={[{ value: 'requests', label: 'Requests' }, { value: 'totalTokens', label: 'Tokens' }, { value: 'costUsd', label: 'Cost' }, { value: 'errors', label: 'Errors' }]} />}
        >
          <TimeSeriesChart data={ts.data} metric={metric} height={300} loading={ts.isLoading} />
        </Card>
        <Card title="Alerts" actions={alerts.data?.length ? <span className="text-xs text-muted">{alerts.data.length}</span> : null}>
          {!alerts.data?.length ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted"><CheckCircle2 className="size-4 text-ok" /> All keys healthy, no budgets near their limit.</div>
          ) : (
            <ul className="max-h-[300px] space-y-2 overflow-y-auto">
              {alerts.data.map((a, i) => (
                <li key={i}>
                  <Link to={a.ref.type === 'gatewayKey' ? `/gateway-keys/${a.ref.id}` : a.ref.type === 'provider' ? `/providers/${a.ref.id}` : '/keys'} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                    {a.severity === 'error' ? <XCircle className="mt-0.5 size-4 shrink-0 text-err" /> : a.severity === 'warning' ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /> : <Info className="mt-0.5 size-4 shrink-0 text-accent" />}
                    <span className="break-words">{a.message}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Top models" actions={<span className="text-xs text-muted">by requests</span>}><TopList rows={topModels.data} metric="requests" /></Card>
        <Card title="Top gateway keys" actions={<span className="text-xs text-muted">by cost</span>}><TopList rows={topGk.data} metric="costUsd" /></Card>
        <Card title="Rotation balance" actions={<span className="text-xs text-muted">requests per upstream key</span>}><TopList rows={topKeys.data} metric="requests" /></Card>
      </div>
      <div className="mt-6 flex justify-end">
        <Link to="/analytics"><Button variant="ghost">Open analytics <ArrowRight className="size-4" /></Button></Link>
      </div>
    </>
  );
}
