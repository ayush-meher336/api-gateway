import { Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useAliases, useModels, useMut, useProviders, useUpstreamKeys } from '../../lib/queries';
import { STRATEGIES, STRATEGY_INFO, type GatewayKey, type KeyPool, type Strategy } from '../../lib/types';
import { Badge, Button, cx, Dialog, ErrorNote, Field, Input, NumberInput, Select, Switch, TagInput, Textarea } from '../ui';

const STEPS = ['Basics', 'Access', 'Key pool', 'Routing', 'Limits', 'Advanced'] as const;

function MultiPick<T extends string | number>({ all, value, onChange, options, allLabel }: { all: boolean; value: T[]; onChange: (all: boolean, v: T[]) => void; options: { value: T; label: string; hint?: string }[]; allLabel: string }) {
  const [q, setQ] = useState('');
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
  return (
    <div className="rounded-lg border border-border">
      <label className="flex items-center justify-between border-b border-border px-3 py-2 text-sm">
        <span>{allLabel}</span>
        <Switch checked={all} onChange={(v) => onChange(v, value)} label={allLabel} />
      </label>
      {!all && (
        <div>
          {options.length > 8 && (
            <div className="border-b border-border p-2">
              <Input className="h-8" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          <div className="max-h-56 overflow-y-auto p-1">
            {shown.map((o) => {
              const on = value.includes(o.value);
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  onClick={() => onChange(false, on ? value.filter((v) => v !== o.value) : [...value, o.value])}
                  className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2', on && 'text-accent')}
                >
                  <span className={cx('grid size-4 shrink-0 place-items-center rounded border', on ? 'border-accent bg-accent text-white' : 'border-border')}>{on && <Check className="size-3" />}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{o.label}</span>
                  {o.hint && <span className="text-xs text-muted">{o.hint}</span>}
                </button>
              );
            })}
            {!options.length && <p className="px-2 py-3 text-sm text-muted">Nothing to choose yet.</p>}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-xs text-muted">{value.length} selected</div>
        </div>
      )}
    </div>
  );
}

function JsonField({ label, hint, value, onChange }: { label: string; hint: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>, ok: boolean) => void }) {
  const [text, setText] = useState(() => (Object.keys(value).length ? JSON.stringify(value, null, 2) : ''));
  const [err, setErr] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} error={err}>
      <Textarea
        rows={4}
        value={text}
        placeholder={'{ "temperature": 0.2 }'}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setErr(null);
            return onChange({}, true);
          }
          try {
            const v = JSON.parse(e.target.value);
            if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Must be a JSON object');
            setErr(null);
            onChange(v, true);
          } catch (x) {
            setErr((x as Error).message);
            onChange(value, false);
          }
        }}
      />
    </Field>
  );
}

const toDateInput = (ts: number | null) => (ts ? new Date(ts - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');

export function GatewayKeyWizard({ initial, onClose, onCreated }: { initial?: GatewayKey; onClose: () => void; onCreated?: (k: GatewayKey) => void }) {
  const providers = useProviders();
  const keys = useUpstreamKeys();
  const models = useModels();
  const aliases = useAliases();
  const [step, setStep] = useState(0);
  const [jsonOk, setJsonOk] = useState({ d: true, o: true });
  const [f, setF] = useState(() => ({
    name: initial?.name ?? '',
    enabled: initial?.enabled ?? true,
    expiresAt: initial?.expiresAt ?? null,
    allowedAliases: initial?.allowedAliases ?? null,
    allowedModelIds: initial?.allowedModelIds ?? null,
    allowedProviderIds: initial?.allowedProviderIds ?? null,
    pool: initial?.pool ?? ({ mode: 'all' } as KeyPool),
    strategy: initial?.strategy ?? ('round_robin' as Strategy),
    maxRetries: initial?.maxRetries ?? 3,
    rpmLimit: initial?.rpmLimit ?? null,
    tpmLimit: initial?.tpmLimit ?? null,
    budgetDailyUsd: initial?.budgetDailyUsd ?? null,
    budgetMonthlyUsd: initial?.budgetMonthlyUsd ?? null,
    tokenQuotaTotal: initial?.tokenQuotaTotal ?? null,
    maxTokensCap: initial?.maxTokensCap ?? null,
    ipAllowlist: initial?.ipAllowlist ?? [],
    defaultParams: initial?.defaultParams ?? {},
    paramOverrides: initial?.paramOverrides ?? {},
    logBodies: initial?.logBodies ?? false,
  }));
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const pName = useMemo(() => new Map(providers.data?.map((p) => [p.id, p.name])), [providers.data]);
  const allTags = useMemo(() => [...new Set(keys.data?.flatMap((k) => k.tags) ?? [])].sort(), [keys.data]);

  const matching = useMemo(() => {
    const ks = keys.data ?? [];
    const p = f.pool;
    const inPool = ks.filter((k) =>
      p.mode === 'all' ? true : p.mode === 'explicit' ? p.keyIds.includes(k.id) : p.mode === 'tags' ? k.tags.some((t) => p.tags.includes(t)) : p.providerIds.includes(k.providerId),
    );
    return f.allowedProviderIds ? inPool.filter((k) => f.allowedProviderIds!.includes(k.providerId)) : inPool;
  }, [keys.data, f.pool, f.allowedProviderIds]);

  const save = useMut(
    () => (initial ? api<GatewayKey>(`gateway-keys/${initial.id}`, { method: 'PATCH', json: f }) : api<GatewayKey>('gateway-keys', { method: 'POST', json: f })),
    [['gateway-keys']],
  );
  const poolValid = f.pool.mode === 'all' || (f.pool.mode === 'explicit' ? f.pool.keyIds.length : f.pool.mode === 'tags' ? f.pool.tags.length : f.pool.providerIds.length) > 0;
  // A restriction with nothing ticked would block every request — never what anyone means.
  const emptyScope = [f.allowedModelIds?.length === 0 && 'models', f.allowedProviderIds?.length === 0 && 'providers'].filter(Boolean) as string[];
  const valid = f.name.trim() && poolValid && jsonOk.d && jsonOk.o && !emptyScope.length;
  const last = step === STEPS.length - 1;

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={initial ? `Edit ${initial.name}` : 'Create gateway key'}
      footer={
        <>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
          <div className="flex-1" />
          {!last && <Button onClick={() => setStep(step + 1)}>Next</Button>}
          <Button
            variant="primary"
            disabled={!valid}
            loading={save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: (k) => (onCreated?.(k), onClose()) })}
          >
            {initial ? 'Save changes' : 'Create key'}
          </Button>
        </>
      }
    >
      <ol className="mb-5 flex flex-wrap gap-1.5">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" onClick={() => setStep(i)} className={cx('rounded-full px-3 py-1 text-xs font-medium', i === step ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted hover:text-fg')}>
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-4">
          <Field label="Name" hint="Which app or person uses this key.">
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="my-chat-app" />
          </Field>
          <Field label="Expires" hint="Leave empty for no expiry.">
            <Input type="datetime-local" value={toDateInput(f.expiresAt)} onChange={(e) => set('expiresAt', e.target.value ? new Date(e.target.value).getTime() : null)} />
          </Field>
          <label className="flex items-center gap-2 text-sm"><Switch checked={f.enabled} onChange={(v) => set('enabled', v)} label="Enabled" /> Enabled</label>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <Field label="Allowed aliases" hint="With a restricted alias list, raw provider/model ids are blocked unless you also restrict models below.">
            <MultiPick
              allLabel="All aliases"
              all={f.allowedAliases === null}
              value={f.allowedAliases ?? []}
              onChange={(all, v) => set('allowedAliases', all ? null : v)}
              options={(aliases.data ?? []).map((a) => ({ value: a.name, label: a.name, hint: `${a.targets.length} targets` }))}
            />
          </Field>
          <Field label="Allowed models">
            <MultiPick
              allLabel="All models"
              all={f.allowedModelIds === null}
              value={f.allowedModelIds ?? []}
              onChange={(all, v) => set('allowedModelIds', all ? null : v)}
              options={(models.data ?? []).filter((m) => m.enabled).map((m) => ({ value: m.id, label: `${pName.get(m.providerId)}/${m.upstreamModelId}` }))}
            />
          </Field>
          <Field label="Allowed providers">
            <MultiPick
              allLabel="All providers"
              all={f.allowedProviderIds === null}
              value={f.allowedProviderIds ?? []}
              onChange={(all, v) => set('allowedProviderIds', all ? null : v)}
              options={(providers.data ?? []).map((p) => ({ value: p.id, label: p.name, hint: `${p.keyCount} keys` }))}
            />
          </Field>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <Field label="Which upstream keys can this gateway key rotate through?">
            <Select
              value={f.pool.mode}
              onChange={(e) => {
                const m = e.target.value as KeyPool['mode'];
                set('pool', m === 'all' ? { mode: 'all' } : m === 'explicit' ? { mode: 'explicit', keyIds: [] } : m === 'tags' ? { mode: 'tags', tags: [] } : { mode: 'providers', providerIds: [] });
              }}
            >
              <option value="all">All keys of the allowed providers</option>
              <option value="providers">All keys of specific providers</option>
              <option value="tags">Keys with any of these tags</option>
              <option value="explicit">Hand-picked keys</option>
            </Select>
          </Field>
          {f.pool.mode === 'providers' && (
            <MultiPick allLabel="—" all={false} value={f.pool.providerIds} onChange={(_, v) => set('pool', { mode: 'providers', providerIds: v })} options={(providers.data ?? []).map((p) => ({ value: p.id, label: p.name, hint: `${p.keyCount} keys` }))} />
          )}
          {f.pool.mode === 'tags' && (
            <Field label="Tags" hint={allTags.length ? `Existing tags: ${allTags.join(', ')}` : 'Tag keys on the Upstream keys page.'}>
              <TagInput value={f.pool.tags} onChange={(v) => set('pool', { mode: 'tags', tags: v })} placeholder="Type a tag and press Enter" />
            </Field>
          )}
          {f.pool.mode === 'explicit' && (
            <MultiPick
              allLabel="—"
              all={false}
              value={f.pool.keyIds}
              onChange={(_, v) => set('pool', { mode: 'explicit', keyIds: v })}
              options={(keys.data ?? []).map((k) => ({ value: k.id, label: `${pName.get(k.providerId)} · ${k.label} ••••${k.secretPreview}`, hint: k.status !== 'active' ? k.status : undefined }))}
            />
          )}
          <div className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm">
            <span className="font-semibold tabular">{matching.length}</span> key{matching.length === 1 ? '' : 's'} currently match
            {matching.length > 0 && <span className="text-muted"> · {[...new Set(matching.map((k) => pName.get(k.providerId)))].join(', ')}</span>}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div className="grid gap-2">
            {STRATEGIES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => set('strategy', s)}
                className={cx('rounded-lg border px-3.5 py-2.5 text-left', f.strategy === s ? 'border-accent bg-accent/5' : 'border-border hover:bg-surface-2')}
              >
                <div className="flex items-center gap-2 text-sm font-medium">{STRATEGY_INFO[s].label}{s === 'round_robin' && <Badge tone="accent">recommended</Badge>}</div>
                <div className="mt-0.5 text-xs text-muted">{STRATEGY_INFO[s].help}</div>
              </button>
            ))}
          </div>
          <Field label="Max retries" hint="On rate limits, server errors or timeouts, try up to this many other keys/providers before failing.">
            <NumberInput value={f.maxRetries} onChange={(v) => set('maxRetries', v ?? 0)} placeholder="3" step={1} min={0} />
          </Field>
        </div>
      )}

      {step === 4 && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Requests / minute"><NumberInput value={f.rpmLimit} onChange={(v) => set('rpmLimit', v)} min={1} step={1} /></Field>
          <Field label="Tokens / minute"><NumberInput value={f.tpmLimit} onChange={(v) => set('tpmLimit', v)} min={1} step={1} /></Field>
          <Field label="Daily budget (USD)"><NumberInput value={f.budgetDailyUsd} onChange={(v) => set('budgetDailyUsd', v)} min={0} /></Field>
          <Field label="Monthly budget (USD)"><NumberInput value={f.budgetMonthlyUsd} onChange={(v) => set('budgetMonthlyUsd', v)} min={0} /></Field>
          <Field label="Lifetime token quota"><NumberInput value={f.tokenQuotaTotal} onChange={(v) => set('tokenQuotaTotal', v)} min={1} step={1} /></Field>
          <Field label="Max output tokens per request" hint="Caps max_tokens; sets it when the request has none."><NumberInput value={f.maxTokensCap} onChange={(v) => set('maxTokensCap', v)} min={1} step={1} /></Field>
          <Field label="IP allowlist" hint="Exact IPs or IPv4 CIDR, e.g. 127.0.0.1, 192.168.1.0/24. Empty = any." className="sm:col-span-2">
            <TagInput value={f.ipAllowlist} onChange={(v) => set('ipAllowlist', v)} placeholder="127.0.0.1" />
          </Field>
          <p className="text-xs text-muted sm:col-span-2">Budgets need model prices to be set on the Models page.</p>
        </div>
      )}

      {step === 5 && (
        <div className="space-y-4">
          <JsonField label="Default parameters" hint="Applied when the request does not set them." value={f.defaultParams} onChange={(v, ok) => (set('defaultParams', v), setJsonOk((j) => ({ ...j, d: ok })))} />
          <JsonField label="Forced overrides" hint="Always replace whatever the request sent (model cannot be overridden)." value={f.paramOverrides} onChange={(v, ok) => (set('paramOverrides', v), setJsonOk((j) => ({ ...j, o: ok })))} />
          <label className="flex items-start gap-2 text-sm">
            <Switch checked={f.logBodies} onChange={(v) => set('logBodies', v)} label="Log bodies" />
            <span>Store full request and response bodies in logs<br /><span className="text-xs text-muted">Useful for debugging; uses disk and keeps prompts on this machine.</span></span>
          </label>
        </div>
      )}
      {emptyScope.length > 0 && (
        <div className="mt-4 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm">
          Access: you turned off “All {emptyScope.join(' / ')}” but selected none, which would block every request. Select at least one or switch “All” back on.{' '}
          <button type="button" className="font-medium text-accent hover:underline" onClick={() => setStep(1)}>Go to Access</button>
        </div>
      )}
      <div className="mt-4"><ErrorNote error={save.error} /></div>
    </Dialog>
  );
}
