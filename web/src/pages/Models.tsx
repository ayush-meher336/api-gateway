import { Boxes, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ConfirmButton, Dialog, Empty, ErrorNote, Field, Input, NumberInput, PageHeader, Select, Spinner, Switch, T } from '../components/ui';
import { api } from '../lib/api';
import { fmtNum } from '../lib/format';
import { CONFIG_KEYS, useModels, useMut, useProviders } from '../lib/queries';
import type { Model } from '../lib/types';

type PriceField = 'priceInputPerM' | 'priceOutputPerM' | 'priceCachedReadPerM' | 'priceCacheWritePerM';

/** Inline price cell: edits commit on blur / Enter. */
function PriceCell({ m, field }: { m: Model; field: PriceField }) {
  const toast = useToast();
  const [v, setV] = useState(m[field] == null ? '' : String(m[field]));
  const save = useMut((value: number | null) => api(`models/${m.id}`, { method: 'PATCH', json: { [field]: value } }), [['models']]);
  const commit = () => {
    const next = v.trim() === '' ? null : Number(v);
    if (next !== null && (!Number.isFinite(next) || next < 0)) return setV(m[field] == null ? '' : String(m[field]));
    if (next !== m[field]) save.mutate(next, { onError: toast.err });
  };
  return (
    <input
      className="tabular h-7 w-20 rounded border border-transparent bg-transparent px-1.5 text-right text-sm hover:border-border focus:border-accent focus:bg-surface focus:outline-none"
      value={v}
      placeholder="—"
      inputMode="decimal"
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      aria-label={field}
    />
  );
}

export function ModelsTable({ models, showProvider = true }: { models: Model[]; showProvider?: boolean }) {
  const toast = useToast();
  const providers = useProviders();
  const pName = new Map(providers.data?.map((p) => [p.id, p.name]));
  const toggle = useMut((m: Model) => api(`models/${m.id}`, { method: 'PATCH', json: { enabled: !m.enabled } }), CONFIG_KEYS);
  const del = useMut((id: number) => api(`models/${id}`, { method: 'DELETE' }), CONFIG_KEYS);
  return (
    <div className={T.wrap}>
      <table className={T.table}>
        <thead>
          <tr>
            <th className={T.th}>Model</th>
            {showProvider && <th className={T.th}>Provider</th>}
            <th className={T.th}>Context</th>
            <th className={`${T.th} text-right`}>$ in / 1M</th>
            <th className={`${T.th} text-right`}>$ out / 1M</th>
            <th className={`${T.th} text-right`}>$ cached / 1M</th>
            <th className={`${T.th} text-right`}>$ cache write / 1M</th>
            <th className={T.th}>Req 24h</th>
            <th className={T.th}>Enabled</th>
            <th className={T.th} />
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id} className={T.row}>
              <td className={T.td}>
                <div className="font-mono text-[13px]">{m.upstreamModelId}</div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {m.displayName && <span className="text-xs text-muted">{m.displayName}</span>}
                  {m.capabilities.embeddings && <Badge>embeddings</Badge>}
                  {m.capabilities.vision && <Badge>vision</Badge>}
                  {m.source === 'manual' && <Badge tone="accent">manual</Badge>}
                </div>
              </td>
              {showProvider && <td className={T.td}>{pName.get(m.providerId)}</td>}
              <td className={`${T.td} tabular text-muted`}>{m.contextLength ? fmtNum(m.contextLength) : '—'}</td>
              {(['priceInputPerM', 'priceOutputPerM', 'priceCachedReadPerM', 'priceCacheWritePerM'] as const).map((f) => (
                <td key={f} className={`${T.td} text-right`}><PriceCell m={m} field={f} /></td>
              ))}
              <td className={`${T.td} tabular`}>{fmtNum(m.last24h?.requests ?? 0)}</td>
              <td className={T.td}><Switch checked={m.enabled} onChange={() => toggle.mutate(m, { onError: toast.err })} label="Enabled" /></td>
              <td className={`${T.td} text-right`}>
                <ConfirmButton size="sm" variant="ghost" aria-label="Delete" icon={<Trash2 className="size-3.5 text-err" />} message={`Delete ${m.upstreamModelId}? Aliases pointing at it lose that target.`} onConfirm={() => del.mutate(m.id, { onError: toast.err })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddModel({ onClose }: { onClose: () => void }) {
  const providers = useProviders();
  const toast = useToast();
  const [providerId, setProviderId] = useState<number | ''>('');
  const [id, setId] = useState('');
  const [pin, setPin] = useState<number | null>(null);
  const [pout, setPout] = useState<number | null>(null);
  const pid = providerId || providers.data?.[0]?.id;
  const save = useMut(() => api('models', { method: 'POST', json: { providerId: pid, upstreamModelId: id.trim(), priceInputPerM: pin, priceOutputPerM: pout } }), CONFIG_KEYS);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Add model manually"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!id.trim() || !pid} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.ok('Model added'), onClose()) })}>Add model</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Provider">
          <Select value={pid ?? ''} onChange={(e) => setProviderId(Number(e.target.value))}>
            {providers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Upstream model id" hint="Exactly as the provider expects it, e.g. gpt-4o or claude-sonnet-4-5.">
          <Input value={id} onChange={(e) => setId(e.target.value)} className="font-mono" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="$ input per 1M tokens"><NumberInput value={pin} onChange={setPin} placeholder="0" min={0} /></Field>
          <Field label="$ output per 1M tokens"><NumberInput value={pout} onChange={setPout} placeholder="0" min={0} /></Field>
        </div>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}

export function Models() {
  const models = useModels();
  const providers = useProviders();
  const [providerId, setProviderId] = useState('');
  const [q, setQ] = useState('');
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [adding, setAdding] = useState(false);
  const rows = (models.data ?? []).filter(
    (m) => (!providerId || m.providerId === Number(providerId)) && (!onlyEnabled || m.enabled) && (!q || `${m.upstreamModelId} ${m.displayName ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  );
  const shown = rows.slice(0, 500);
  return (
    <>
      <PageHeader
        title="Models"
        subtitle="Every model the gateway can reach. Set prices to get cost analytics; disable models you never want routed."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} disabled={!providers.data?.length} onClick={() => setAdding(true)}>Add model</Button>}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select className="w-auto" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">All providers</option>
          {providers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Input className="w-64" placeholder="Search models…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-2 text-sm text-muted">
          <Switch checked={onlyEnabled} onChange={setOnlyEnabled} label="Only enabled" /> Only enabled
        </label>
        <span className="ml-auto text-sm text-muted">{rows.length} models{rows.length > shown.length ? ` · showing first ${shown.length}` : ''}</span>
      </div>
      <ErrorNote error={models.error} />
      <Card pad={false}>
        {models.isLoading ? (
          <div className="grid h-40 place-items-center"><Spinner /></div>
        ) : !models.data?.length ? (
          <Empty icon={<Boxes className="size-8" />} title="No models yet">Open Providers and click “Sync models”, or add one manually.</Empty>
        ) : shown.length ? (
          <ModelsTable models={shown} />
        ) : (
          <Empty title="No models match" />
        )}
      </Card>
      {adding && <AddModel onClose={() => setAdding(false)} />}
    </>
  );
}
