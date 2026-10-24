import { Pencil, Plus, Trash2, Waypoints } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useToast } from '../components/toast';
import { Badge, Button, Card, ConfirmButton, Dialog, Empty, ErrorNote, Field, Input, Mono, NumberInput, PageHeader, Spinner, Switch } from '../components/ui';
import { api } from '../lib/api';
import { CONFIG_KEYS, useAliases, useModels, useMut, useProviders } from '../lib/queries';
import type { Alias, AliasTarget } from '../lib/types';

function AliasBuilder({ alias, onClose }: { alias?: Alias; onClose: () => void }) {
  const toast = useToast();
  const models = useModels();
  const providers = useProviders();
  const pName = useMemo(() => new Map(providers.data?.map((p) => [p.id, p.name])), [providers.data]);
  const [name, setName] = useState(alias?.name ?? '');
  const [description, setDescription] = useState(alias?.description ?? '');
  const [enabled, setEnabled] = useState(alias?.enabled ?? true);
  const [targets, setTargets] = useState<AliasTarget[]>(alias?.targets ?? []);
  const [search, setSearch] = useState('');

  const modelLabel = (id: number) => {
    const m = models.data?.find((x) => x.id === id);
    return m ? `${pName.get(m.providerId)}/${m.upstreamModelId}` : `#${id}`;
  };
  // Suggest the same model id on every provider, e.g. typing "gpt-4o" finds openai/gpt-4o and openrouter/openai/gpt-4o.
  const suggestions = (models.data ?? [])
    .filter((m) => !targets.some((t) => t.modelId === m.id))
    .filter((m) => search && `${pName.get(m.providerId)}/${m.upstreamModelId}`.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 30);

  const save = useMut(() => {
    const body = { name: name.trim(), description: description || null, enabled, targets: targets.map(({ modelId, weight, priority, enabled }) => ({ modelId, weight, priority, enabled })) };
    return alias ? api(`aliases/${alias.id}`, { method: 'PATCH', json: body }) : api('aliases', { method: 'POST', json: body });
  }, CONFIG_KEYS);
  const update = (i: number, patch: Partial<AliasTarget>) => setTargets(targets.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={alias ? `Edit alias ${alias.name}` : 'New alias'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !targets.length} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.ok('Alias saved'), onClose()) })}>
            Save alias
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Alias name" hint="What your apps send as “model”. Can match a real model name, e.g. gpt-4o.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="gpt-4o" className="font-mono" />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-medium">Targets ({targets.length})</span>
            <span className="text-xs text-muted">Every target × the gateway key's pool keys forms the rotation.</span>
          </div>
          <div className="space-y-2">
            {targets.map((t, i) => (
              <div key={t.modelId} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-2">
                <Mono className="min-w-0 flex-1 truncate">{modelLabel(t.modelId)}</Mono>
                <label className="flex items-center gap-1 text-xs text-muted">Weight <div className="w-20"><NumberInput value={t.weight} onChange={(v) => update(i, { weight: v ?? 1 })} placeholder="1" min={0} /></div></label>
                <label className="flex items-center gap-1 text-xs text-muted">Priority <div className="w-16"><NumberInput value={t.priority} onChange={(v) => update(i, { priority: v ?? 0 })} placeholder="0" step={1} min={0} /></div></label>
                <Switch checked={t.enabled} onChange={(v) => update(i, { enabled: v })} label="Target enabled" />
                <Button size="sm" variant="ghost" aria-label="Remove target" icon={<Trash2 className="size-3.5" />} onClick={() => setTargets(targets.filter((_, j) => j !== i))} />
              </div>
            ))}
            {!targets.length && <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted">Search below to add one or more provider models.</p>}
          </div>
        </div>
        <Field label="Add target" hint="Search across all providers. Add the same model from several providers to spread load between them.">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a model name…" />
        </Field>
        {suggestions.length > 0 && (
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
            {suggestions.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setTargets([...targets, { modelId: m.id, weight: 1, priority: 0, enabled: true }])}
                className="flex w-full items-center justify-between border-b border-border px-3 py-2 text-left text-sm last:border-0 hover:bg-surface-2"
              >
                <span className="font-mono text-[13px]">{pName.get(m.providerId)}/{m.upstreamModelId}</span>
                <Plus className="size-4 text-muted" />
              </button>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm"><Switch checked={enabled} onChange={setEnabled} label="Alias enabled" /> Alias enabled</label>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}

export function Aliases() {
  const aliases = useAliases();
  const models = useModels();
  const providers = useProviders();
  const toast = useToast();
  const [edit, setEdit] = useState<Alias | 'new' | null>(null);
  const pName = new Map(providers.data?.map((p) => [p.id, p.name]));
  const mLabel = (id: number) => {
    const m = models.data?.find((x) => x.id === id);
    return m ? `${pName.get(m.providerId)}/${m.upstreamModelId}` : `#${id} (deleted)`;
  };
  const del = useMut((id: number) => api(`aliases/${id}`, { method: 'DELETE' }), CONFIG_KEYS);
  const toggle = useMut((a: Alias) => api(`aliases/${a.id}`, { method: 'PATCH', json: { enabled: !a.enabled } }), CONFIG_KEYS);

  return (
    <>
      <PageHeader
        title="Aliases"
        subtitle="One public model name that fans out to the same (or interchangeable) models on several providers."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>New alias</Button>}
      />
      <ErrorNote error={aliases.error} />
      {aliases.isLoading ? (
        <div className="grid h-40 place-items-center"><Spinner /></div>
      ) : !aliases.data?.length ? (
        <Card>
          <Empty icon={<Waypoints className="size-8" />} title="No aliases yet" action={<Button variant="primary" onClick={() => setEdit('new')}>Create an alias</Button>}>
            Example: an alias “gpt-4o” targeting openai/gpt-4o and openrouter/openai/gpt-4o rotates across both providers' keys.
          </Empty>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {aliases.data.map((a) => (
            <Card
              key={a.id}
              title={<span className="font-mono">{a.name}</span>}
              actions={
                <>
                  <Switch checked={a.enabled} onChange={() => toggle.mutate(a, { onError: toast.err })} label="Enabled" />
                  <Button size="sm" variant="ghost" aria-label="Edit" icon={<Pencil className="size-3.5" />} onClick={() => setEdit(a)} />
                  <ConfirmButton size="sm" variant="ghost" aria-label="Delete" icon={<Trash2 className="size-3.5 text-err" />} message={`Delete alias ${a.name}? Apps using it will get "model not allowed".`} onConfirm={() => del.mutate(a.id, { onError: toast.err })} />
                </>
              }
            >
              {a.description && <p className="mb-3 text-sm text-muted">{a.description}</p>}
              <ul className="space-y-1.5">
                {a.targets.map((t) => (
                  <li key={t.modelId} className="flex items-center justify-between gap-2 text-sm">
                    <Mono className={t.enabled ? 'truncate' : 'truncate line-through opacity-60'}>{mLabel(t.modelId)}</Mono>
                    <span className="flex shrink-0 gap-1">
                      {t.weight !== 1 && <Badge>w {t.weight}</Badge>}
                      {t.priority !== 0 && <Badge tone="warn">p {t.priority}</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
      {edit && <AliasBuilder alias={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </>
  );
}
