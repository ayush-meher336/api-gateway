import { KeyRound, Pencil, Plus, RefreshCw, Server, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BulkKeysDialog } from '../components/forms/BulkKeysDialog';
import { ProviderForm } from '../components/forms/ProviderForm';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ConfirmButton, Empty, ErrorNote, Mono, PageHeader, Spinner, Switch, T } from '../components/ui';
import { api } from '../lib/api';
import { fmtNum, fmtUsd } from '../lib/format';
import { CONFIG_KEYS, useMut, useProviders } from '../lib/queries';
import { PROVIDER_LABELS, type Provider } from '../lib/types';

export function useProviderActions() {
  const toast = useToast();
  const test = useMut((id: number) => api<{ ok: boolean; models?: number; error?: string; latencyMs: number }>(`providers/${id}/test`, { method: 'POST' }));
  const sync = useMut((id: number) => api<{ added: number; updated: number }>(`providers/${id}/sync-models`, { method: 'POST' }), CONFIG_KEYS);
  return {
    test: (p: Provider) =>
      test.mutate(p.id, {
        onSuccess: (r) => (r.ok ? toast.ok(`${p.name}: connected in ${r.latencyMs} ms · ${r.models} models visible`) : toast.err(`${p.name}: ${r.error}`)),
        onError: toast.err,
      }),
    sync: (p: Provider) =>
      sync.mutate(p.id, {
        onSuccess: (r) => toast.ok(`${p.name}: ${r.added} new model${r.added === 1 ? '' : 's'}, ${r.updated} updated`),
        onError: toast.err,
      }),
    testing: test.isPending ? test.variables : null,
    syncing: sync.isPending ? sync.variables : null,
  };
}

export function Providers() {
  const q = useProviders();
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const [addKeysFor, setAddKeysFor] = useState<number | null>(null);
  const actions = useProviderActions();
  const toast = useToast();
  const toggle = useMut((p: Provider) => api(`providers/${p.id}`, { method: 'PATCH', json: { enabled: !p.enabled } }), CONFIG_KEYS);
  const del = useMut((id: number) => api(`providers/${id}`, { method: 'DELETE' }), CONFIG_KEYS);

  return (
    <>
      <PageHeader
        title="Providers"
        subtitle="AI services the gateway can route to. Each provider holds its own pool of API keys and models."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Add provider</Button>}
      />
      <ErrorNote error={q.error} />
      <Card pad={false}>
        {q.isLoading ? (
          <div className="grid h-40 place-items-center"><Spinner /></div>
        ) : !q.data?.length ? (
          <Empty icon={<Server className="size-8" />} title="No providers yet" action={<Button variant="primary" onClick={() => setEditing('new')}>Add your first provider</Button>}>
            Add OpenAI, Anthropic, Gemini, OpenRouter, Groq and others — or any OpenAI-compatible endpoint.
          </Empty>
        ) : (
          <div className={T.wrap}>
            <table className={T.table}>
              <thead>
                <tr>
                  <th className={T.th}>Provider</th>
                  <th className={T.th}>Keys</th>
                  <th className={T.th}>Models</th>
                  <th className={T.th}>Requests 24h</th>
                  <th className={T.th}>Cost 24h</th>
                  <th className={T.th}>Enabled</th>
                  <th className={T.th} />
                </tr>
              </thead>
              <tbody>
                {q.data.map((p) => (
                  <tr key={p.id} className={T.row}>
                    <td className={T.td}>
                      <Link to={`/providers/${p.id}`} className="font-medium hover:text-accent">{p.name}</Link>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                        <span>{PROVIDER_LABELS[p.type]}</span>
                        <Mono className="max-w-[260px] truncate">{p.baseUrl}</Mono>
                      </div>
                    </td>
                    <td className={T.td}>
                      <span className="tabular">{p.activeKeyCount}</span>
                      <span className="text-muted"> / {p.keyCount}</span>
                      {p.keyCount > 0 && p.activeKeyCount === 0 && <Badge tone="err" className="ml-2">none active</Badge>}
                    </td>
                    <td className={`${T.td} tabular`}>{p.modelCount}</td>
                    <td className={`${T.td} tabular`}>
                      {fmtNum(p.last24h.requests)}
                      {p.last24h.errors > 0 && <span className="ml-1.5 text-xs text-err">{fmtNum(p.last24h.errors)} err</span>}
                    </td>
                    <td className={`${T.td} tabular`}>{fmtUsd(p.last24h.costUsd)}</td>
                    <td className={T.td}>
                      <Switch checked={p.enabled} onChange={() => toggle.mutate(p, { onError: toast.err })} label="Enabled" />
                    </td>
                    <td className={`${T.td} text-right`}>
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setAddKeysFor(p.id)}>Keys</Button>
                        <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} loading={actions.syncing === p.id} onClick={() => actions.sync(p)}>Sync models</Button>
                        <Button size="sm" variant="ghost" icon={<Zap className="size-3.5" />} loading={actions.testing === p.id} onClick={() => actions.test(p)}>Test</Button>
                        <Button size="sm" variant="ghost" aria-label="Edit" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(p)} />
                        <ConfirmButton
                          size="sm"
                          variant="ghost"
                          aria-label="Delete"
                          icon={<Trash2 className="size-3.5 text-err" />}
                          message={`Delete ${p.name}? Its ${p.keyCount} keys and ${p.modelCount} models are removed too. Logs are kept.`}
                          onConfirm={() => del.mutate(p.id, { onSuccess: () => toast.ok('Provider deleted'), onError: toast.err })}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <ProviderForm open onClose={() => setEditing(null)} provider={editing === 'new' ? undefined : editing} />}
      {addKeysFor && <BulkKeysDialog open providerId={addKeysFor} onClose={() => setAddKeysFor(null)} />}
    </>
  );
}
