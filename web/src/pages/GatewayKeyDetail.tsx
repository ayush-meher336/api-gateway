import { ArrowLeft, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { KpiTile, Progress, TimeSeriesChart } from '../components/charts';
import { GatewayKeyWizard } from '../components/forms/GatewayKeyWizard';
import { KeyReveal } from '../components/KeyReveal';
import { TimeRangePicker, useRange } from '../components/TimeRangePicker';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ConfirmButton, Empty, Mono, PageHeader, Spinner, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { fmtDateTime, fmtMs, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { useGatewayKey, useMut, useProviders, useSummary, useTimeseries } from '../lib/queries';
import { STRATEGY_INFO, type GroupBy, type Metric } from '../lib/types';
import { poolSummary } from './GatewayKeys';

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-2 text-sm last:border-0">
      <span className="text-muted">{k}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

export function GatewayKeyDetail() {
  const id = Number(useParams().id);
  const q = useGatewayKey(id);
  const providers = useProviders();
  const nav = useNavigate();
  const toast = useToast();
  const rs = useRange('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const [groupBy, setGroupBy] = useState<GroupBy>('upstreamKey');
  const summary = useSummary(rs.range, { gatewayKeyId: id });
  const ts = useTimeseries(rs.range, metric, groupBy, { gatewayKeyId: id });
  const [edit, setEdit] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const regen = useMut(() => api<{ key: string }>(`gateway-keys/${id}/regenerate`, { method: 'POST' }), [['gateway-keys']]);
  const del = useMut(() => api(`gateway-keys/${id}`, { method: 'DELETE' }), [['gateway-keys']]);

  if (q.isLoading) return <div className="grid h-60 place-items-center"><Spinner /></div>;
  const k = q.data;
  if (!k) return <Empty title="Gateway key not found" action={<Link to="/gateway-keys"><Button>Back</Button></Link>} />;
  const s = summary.data;
  const pName = new Map(providers.data?.map((p) => [p.id, p.name]));

  return (
    <>
      <Link to="/gateway-keys" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-4" /> Gateway keys</Link>
      <PageHeader
        title={k.name}
        subtitle={<span className="flex items-center gap-2"><Mono>{k.keyPrefix}…</Mono>{!k.enabled && <Badge tone="warn">Disabled</Badge>}</span>}
        actions={
          <>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>Edit</Button>
            <ConfirmButton
              icon={<KeyRound className="size-4" />}
              loading={regen.isPending}
              message="Regenerate this key? The current key stops working immediately."
              onConfirm={() => regen.mutate(undefined, { onSuccess: (r) => setRevealed(r.key), onError: toast.err })}
            >
              Regenerate
            </ConfirmButton>
            <ConfirmButton
              variant="danger"
              icon={<Trash2 className="size-4" />}
              message={`Delete ${k.name}? Apps using it will get 401 errors. Usage history is kept.`}
              onConfirm={() => del.mutate(undefined, { onSuccess: () => (toast.ok('Key deleted'), nav('/gateway-keys')), onError: toast.err })}
            >
              Delete
            </ConfirmButton>
          </>
        }
      />
      <div className="mb-4 flex justify-end"><TimeRangePicker state={rs} /></div>
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Requests" value={fmtNum(s?.requests)} sub={s ? `${fmtPct(s.errorRate)} errors` : undefined} tone={s && s.errorRate > 0.05 ? 'err' : undefined} />
        <KpiTile label="Input tokens" value={fmtNum(s?.inputTokens)} />
        <KpiTile label="Output tokens" value={fmtNum(s?.outputTokens)} />
        <KpiTile label="Cached tokens" value={fmtNum(s?.cachedReadTokens)} sub={s ? `${fmtPct(s.cacheHitRatio)} hit ratio` : undefined} />
        <KpiTile label="Cost" value={fmtUsd(s?.costUsd)} />
        <KpiTile label="Latency p50 / p95" value={fmtMs(s?.p50LatencyMs)} sub={fmtMs(s?.p95LatencyMs)} />
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Usage"
          actions={
            <>
              <Tabs value={groupBy} onChange={setGroupBy} options={[{ value: 'upstreamKey', label: 'By key' }, { value: 'provider', label: 'By provider' }, { value: 'model', label: 'By model' }]} />
              <Tabs value={metric} onChange={setMetric} options={[{ value: 'requests', label: 'Requests' }, { value: 'totalTokens', label: 'Tokens' }, { value: 'costUsd', label: 'Cost' }]} />
            </>
          }
        >
          <TimeSeriesChart data={ts.data} metric={metric} height={300} loading={ts.isLoading} />
        </Card>
        <div className="space-y-6">
          {(k.budgetDailyUsd != null || k.budgetMonthlyUsd != null || k.tokenQuotaTotal != null) && (
            <Card title="Budgets">
              <div className="space-y-4">
                {k.budgetDailyUsd != null && <Progress label={`Today ${fmtUsd(k.spend.dayUsd)} of ${fmtUsd(k.budgetDailyUsd)}`} value={k.spend.dayUsd} max={k.budgetDailyUsd} />}
                {k.budgetMonthlyUsd != null && <Progress label={`This month ${fmtUsd(k.spend.monthUsd)} of ${fmtUsd(k.budgetMonthlyUsd)}`} value={k.spend.monthUsd} max={k.budgetMonthlyUsd} />}
                {k.tokenQuotaTotal != null && <Progress label={`Tokens ${fmtNum(k.spend.totalTokens)} of ${fmtNum(k.tokenQuotaTotal)}`} value={k.spend.totalTokens} max={k.tokenQuotaTotal} />}
              </div>
            </Card>
          )}
          <Card title="Configuration">
            <Row k="Routing">{STRATEGY_INFO[k.strategy].label} · {k.maxRetries} retries</Row>
            <Row k="Key pool">{poolSummary(k)}</Row>
            <Row k="Providers">{k.allowedProviderIds ? k.allowedProviderIds.map((p) => pName.get(p) ?? `#${p}`).join(', ') : 'All'}</Row>
            <Row k="Aliases">{k.allowedAliases ? k.allowedAliases.join(', ') || 'None' : 'All'}</Row>
            <Row k="Models">{k.allowedModelIds ? `${k.allowedModelIds.length} selected` : 'All'}</Row>
            <Row k="Rate limits">{k.rpmLimit ? `${k.rpmLimit} rpm` : '—'} · {k.tpmLimit ? `${fmtNum(k.tpmLimit)} tpm` : '—'}</Row>
            <Row k="Max output tokens">{k.maxTokensCap ?? '—'}</Row>
            <Row k="IP allowlist">{k.ipAllowlist.length ? k.ipAllowlist.join(', ') : 'Any'}</Row>
            <Row k="Expires">{k.expiresAt ? fmtDateTime(k.expiresAt) : 'Never'}</Row>
            <Row k="Body logging">{k.logBodies ? 'On' : 'Off'}</Row>
            <Row k="Created">{fmtDateTime(k.createdAt)}</Row>
            <Row k="Last used">{fmtDateTime(k.lastUsedAt)}</Row>
          </Card>
          <Link to={`/logs?gatewayKeyId=${k.id}`} className="block text-center text-sm text-accent hover:underline">View this key's request logs →</Link>
        </div>
      </div>
      {edit && <GatewayKeyWizard initial={k} onClose={() => setEdit(false)} />}
      {revealed && <KeyReveal secret={revealed} onClose={() => setRevealed(null)} />}
    </>
  );
}
