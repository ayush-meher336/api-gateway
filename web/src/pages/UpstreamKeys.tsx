import { KeyRound, Pencil, Plus, RotateCcw, Trash2, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BulkKeysDialog } from '../components/forms/BulkKeysDialog';
import { KeyStatusBadge } from '../components/KeyStatus';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ConfirmButton, Dialog, Empty, ErrorNote, Field, Input, NumberInput, PageHeader, Select, Spinner, T, TagInput } from '../components/ui';
import { api } from '../lib/api';
import { fmtAgo, fmtNum, fmtUsd } from '../lib/format';
import { CONFIG_KEYS, useMut, useProviders, useUpstreamKeys } from '../lib/queries';
import type { UpstreamKey } from '../lib/types';

function EditKey({ k, onClose }: { k: UpstreamKey; onClose: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState(k.label);
  const [tags, setTags] = useState(k.tags);
  const [weight, setWeight] = useState<number | null>(k.weight);
  const [rpm, setRpm] = useState(k.rpmLimit);
  const [tpm, setTpm] = useState(k.tpmLimit);
  const [dReq, setDReq] = useState(k.dailyRequestCap);
  const [dTok, setDTok] = useState(k.dailyTokenCap);
  const save = useMut(
    () => api(`upstream-keys/${k.id}`, { method: 'PATCH', json: { label, tags, weight: weight ?? 1, rpmLimit: rpm, tpmLimit: tpm, dailyRequestCap: dReq, dailyTokenCap: dTok } }),
    CONFIG_KEYS,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit key ••••${k.secretPreview}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.ok('Key saved'), onClose()) })}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        <Field label="Tags"><TagInput value={tags} onChange={setTags} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Weight"><NumberInput value={weight} onChange={setWeight} placeholder="1" min={0} /></Field>
          <Field label="Requests / min"><NumberInput value={rpm} onChange={setRpm} min={1} /></Field>
          <Field label="Tokens / min"><NumberInput value={tpm} onChange={setTpm} min={1} /></Field>
          <Field label="Requests / day"><NumberInput value={dReq} onChange={setDReq} min={1} /></Field>
          <Field label="Tokens / day"><NumberInput value={dTok} onChange={setDTok} min={1} /></Field>
        </div>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}

export function KeysTable({ keys, showProvider = true }: { keys: UpstreamKey[]; showProvider?: boolean }) {
  const toast = useToast();
  const providers = useProviders();
  const pName = new Map(providers.data?.map((p) => [p.id, p.name]));
  const [edit, setEdit] = useState<UpstreamKey | null>(null);
  const patch = useMut((v: { id: number; body: object }) => api(`upstream-keys/${v.id}`, { method: 'PATCH', json: v.body }), CONFIG_KEYS);
  const reset = useMut((id: number) => api(`upstream-keys/${id}/reset`, { method: 'POST' }), CONFIG_KEYS);
  const test = useMut((id: number) => api<{ ok: boolean; error?: string; latencyMs: number }>(`upstream-keys/${id}/test`, { method: 'POST' }), CONFIG_KEYS);
  const del = useMut((id: number) => api(`upstream-keys/${id}`, { method: 'DELETE' }), CONFIG_KEYS);
  const totalReq = keys.reduce((s, k) => s + k.last24h.requests, 0);

  return (
    <>
      <div className={T.wrap}>
        <table className={T.table}>
          <thead>
            <tr>
              <th className={T.th}>Key</th>
              {showProvider && <th className={T.th}>Provider</th>}
              <th className={T.th}>Status</th>
              <th className={T.th}>Tags</th>
              <th className={T.th}>Weight</th>
              <th className={T.th}>Requests 24h</th>
              <th className={T.th}>Tokens 24h</th>
              <th className={T.th}>Cost 24h</th>
              <th className={T.th}>Last used</th>
              <th className={T.th} />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className={T.row}>
                <td className={T.td}>
                  <div className="whitespace-nowrap font-medium">{k.label}</div>
                  <div className="font-mono text-xs text-muted">••••{k.secretPreview}</div>
                </td>
                {showProvider && <td className={T.td}>{pName.get(k.providerId) ?? '—'}</td>}
                <td className={T.td}>
                  <KeyStatusBadge k={k} />
                  {k.lastError && k.status !== 'active' && <div className="mt-1 max-w-[220px] truncate text-xs text-muted" title={k.lastError}>{k.lastError}</div>}
                </td>
                <td className={T.td}>
                  <div className="flex flex-wrap gap-1">{k.tags.map((t) => <Badge key={t} tone="accent">{t}</Badge>)}</div>
                </td>
                <td className={`${T.td} tabular`}>{k.weight}</td>
                <td className={`${T.td} tabular`}>
                  {fmtNum(k.last24h.requests)}
                  {totalReq > 0 && <span className="ml-1 text-xs text-muted">({Math.round((k.last24h.requests / totalReq) * 100)}%)</span>}
                </td>
                <td className={`${T.td} tabular`}>{fmtNum(k.last24h.tokens)}</td>
                <td className={`${T.td} tabular`}>{fmtUsd(k.last24h.costUsd)}</td>
                <td className={`${T.td} text-muted`}>{fmtAgo(k.lastUsedAt)}</td>
                <td className={`${T.td} text-right`}>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Test this key"
                      icon={<Zap className="size-3.5" />}
                      loading={test.isPending && test.variables === k.id}
                      onClick={() => test.mutate(k.id, { onSuccess: (r) => (r.ok ? toast.ok(`Key works (${r.latencyMs} ms)`) : toast.err(r.error)), onError: toast.err })}
                    />
                    {(k.status === 'invalid' || k.status === 'cooldown') && (
                      <Button size="sm" variant="ghost" title="Mark active" icon={<RotateCcw className="size-3.5" />} onClick={() => reset.mutate(k.id, { onError: toast.err })} />
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => patch.mutate({ id: k.id, body: { status: k.status === 'disabled' ? 'active' : 'disabled' } }, { onError: toast.err })}
                    >
                      {k.status === 'disabled' ? 'Enable' : 'Disable'}
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Edit" icon={<Pencil className="size-3.5" />} onClick={() => setEdit(k)} />
                    <ConfirmButton size="sm" variant="ghost" aria-label="Delete" icon={<Trash2 className="size-3.5 text-err" />} message={`Delete key ${k.label}? This cannot be undone.`} onConfirm={() => del.mutate(k.id, { onError: toast.err })} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <EditKey k={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

export function UpstreamKeys() {
  const keys = useUpstreamKeys();
  const providers = useProviders();
  const [adding, setAdding] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [tag, setTag] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const allTags = useMemo(() => [...new Set(keys.data?.flatMap((k) => k.tags) ?? [])].sort(), [keys.data]);
  const now = Date.now();
  const rows = (keys.data ?? []).filter((k) => {
    if (providerId && k.providerId !== Number(providerId)) return false;
    if (tag && !k.tags.includes(tag)) return false;
    if (status) {
      const eff = k.status === 'cooldown' && (k.cooldownUntil ?? 0) <= now ? 'active' : k.status;
      if (eff !== status) return false;
    }
    if (q && !`${k.label} ${k.secretPreview}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <>
      <PageHeader
        title="Upstream keys"
        subtitle="Provider API keys in the rotation pool. Usage share shows how evenly rotation spreads load."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} disabled={!providers.data?.length} onClick={() => setAdding(true)}>Add keys</Button>}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-auto" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
          <option value="">All providers</option>
          {providers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select className="w-auto" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {allTags.map((t) => <option key={t}>{t}</option>)}
        </Select>
        <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="cooldown">Cooldown</option>
          <option value="invalid">Invalid</option>
          <option value="disabled">Disabled</option>
        </Select>
        <Input className="w-56" placeholder="Search label or last 4…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="ml-auto self-center text-sm text-muted">{rows.length} of {keys.data?.length ?? 0}</span>
      </div>
      <ErrorNote error={keys.error} />
      <Card pad={false}>
        {keys.isLoading ? (
          <div className="grid h-40 place-items-center"><Spinner /></div>
        ) : !keys.data?.length ? (
          <Empty icon={<KeyRound className="size-8" />} title="No keys yet" action={providers.data?.length ? <Button variant="primary" onClick={() => setAdding(true)}>Add keys</Button> : undefined}>
            {providers.data?.length ? 'Paste one or many provider API keys at once.' : 'Add a provider first, then its keys.'}
          </Empty>
        ) : rows.length ? (
          <KeysTable keys={rows} />
        ) : (
          <Empty title="No keys match these filters" />
        )}
      </Card>
      {adding && <BulkKeysDialog open onClose={() => setAdding(false)} providerId={providerId ? Number(providerId) : undefined} />}
    </>
  );
}
