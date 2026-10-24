import { ArrowLeft, Pencil, Plus, RefreshCw, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { KpiTile, TimeSeriesChart } from '../components/charts';
import { BulkKeysDialog } from '../components/forms/BulkKeysDialog';
import { ProviderForm } from '../components/forms/ProviderForm';
import { TimeRangePicker, useRange } from '../components/TimeRangePicker';
import { Badge, Button, Card, Empty, Mono, PageHeader, Spinner, Tabs } from '../components/ui';
import { fmtMs, fmtNum, fmtPct, fmtUsd } from '../lib/format';
import { useModels, useProviders, useSummary, useTimeseries, useUpstreamKeys } from '../lib/queries';
import { PROVIDER_LABELS, type Metric } from '../lib/types';
import { useProviderActions } from './Providers';
import { KeysTable } from './UpstreamKeys';
import { ModelsTable } from './Models';

export function ProviderDetail() {
  const id = Number(useParams().id);
  const providers = useProviders();
  const p = providers.data?.find((x) => x.id === id);
  const keys = useUpstreamKeys(id);
  const models = useModels(id);
  const rs = useRange('24h');
  const [metric, setMetric] = useState<Metric>('requests');
  const summary = useSummary(rs.range, { providerId: id });
  const byKey = useTimeseries(rs.range, metric, 'upstreamKey', { providerId: id });
  const actions = useProviderActions();
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);

  if (providers.isLoading) return <div className="grid h-60 place-items-center"><Spinner /></div>;
  if (!p) return <Empty title="Provider not found" action={<Link to="/providers"><Button>Back to providers</Button></Link>} />;
  const s = summary.data;

  return (
    <>
      <Link to="/providers" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-4" /> Providers</Link>
      <PageHeader
        title={p.name}
        subtitle={<span className="flex flex-wrap items-center gap-2">{PROVIDER_LABELS[p.type]} <Mono>{p.baseUrl}</Mono> {!p.enabled && <Badge tone="warn">Disabled</Badge>}</span>}
        actions={
          <>
            <Button icon={<Zap className="size-4" />} loading={actions.testing === p.id} onClick={() => actions.test(p)}>Test</Button>
            <Button icon={<RefreshCw className="size-4" />} loading={actions.syncing === p.id} onClick={() => actions.sync(p)}>Sync models</Button>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>Edit</Button>
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
      <Card
        className="mb-6"
        title="Usage by key"
        actions={<Tabs value={metric} onChange={setMetric} options={[{ value: 'requests', label: 'Requests' }, { value: 'totalTokens', label: 'Tokens' }, { value: 'costUsd', label: 'Cost' }]} />}
      >
        <TimeSeriesChart data={byKey.data} metric={metric} loading={byKey.isLoading} />
      </Card>
      <Card className="mb-6" pad={false} title={`Keys (${keys.data?.length ?? 0})`} actions={<Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>Add keys</Button>}>
        {keys.data?.length ? <KeysTable keys={keys.data} showProvider={false} /> : <Empty title="No keys for this provider" />}
      </Card>
      <Card pad={false} title={`Models (${models.data?.length ?? 0})`}>
        {models.data?.length ? <ModelsTable models={models.data} showProvider={false} /> : <Empty title="No models yet">Use “Sync models” to fetch them, or add one manually on the Models page.</Empty>}
      </Card>
      {edit && <ProviderForm open provider={p} onClose={() => setEdit(false)} />}
      {adding && <BulkKeysDialog open providerId={p.id} onClose={() => setAdding(false)} />}
    </>
  );
}
