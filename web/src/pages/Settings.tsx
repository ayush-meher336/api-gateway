import { Download, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useToast } from '../components/toast';
import { Button, Card, ErrorNote, Field, Input, NumberInput, PageHeader, Spinner, Switch } from '../components/ui';
import { api } from '../lib/api';
import { CONFIG_KEYS, useMut, useSettings } from '../lib/queries';
import type { Settings } from '../lib/types';

function GeneralSettings() {
  const q = useSettings();
  const toast = useToast();
  const [f, setF] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data && !f) setF(q.data);
  }, [q.data, f]);
  const save = useMut((s: Settings) => api<Settings>('settings', { method: 'PUT', json: s }), [['settings']]);
  if (!f) return <Card title="Gateway defaults"><Spinner /></Card>;
  const set = (k: keyof Settings, sec = false) => (v: number | null) => setF({ ...f, [k]: v == null ? 0 : sec ? Math.round(v * 1000) : v });
  return (
    <Card title="Gateway defaults" actions={<Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(f, { onSuccess: (s) => (setF(s), toast.ok('Settings saved')), onError: toast.err })}>Save</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Keep raw request logs (days)" hint="Hourly/daily usage totals are kept forever."><NumberInput value={f.retentionDays} onChange={set('retentionDays')} min={1} step={1} /></Field>
        <Field label="Default max retries for new gateway keys"><NumberInput value={f.defaultMaxRetries} onChange={set('defaultMaxRetries')} min={0} step={1} /></Field>
        <Field label="Rate-limit cooldown per key + model (seconds)" hint="After a 429, that key skips only that model for this long (or the provider's Retry-After). If two keys are refused for the same model, the model is routed around for ~10s."><NumberInput value={f.rateLimitCooldownMs / 1000} onChange={set('rateLimitCooldownMs', true)} min={1} /></Field>
        <Field label="Max cooldown (seconds)"><NumberInput value={f.maxCooldownMs / 1000} onChange={set('maxCooldownMs', true)} min={1} /></Field>
        <Field label="Server-error cooldown (seconds)" hint="After 5xx, network errors or timeouts."><NumberInput value={f.serverErrorCooldownMs / 1000} onChange={set('serverErrorCooldownMs', true)} min={0} /></Field>
        <Field label="Default timeout for new providers (seconds)"><NumberInput value={f.defaultProviderTimeoutMs / 1000} onChange={set('defaultProviderTimeoutMs', true)} min={1} /></Field>
      </div>
      <ErrorNote error={save.error} />
    </Card>
  );
}

function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const save = useMut(() => api('auth/password', { method: 'POST', json: { current, next } }));
  return (
    <Card title="Admin password">
      <div className="space-y-3">
        <Field label="Current password"><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 8 characters. Other sessions are signed out."><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <ErrorNote error={save.error} />
        <Button variant="primary" disabled={!current || next.length < 8} loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.ok('Password changed'), setCurrent(''), setNext('')) })}>Change password</Button>
      </div>
    </Card>
  );
}

function BackupCard() {
  const toast = useToast();
  const dbInput = useRef<HTMLInputElement>(null);
  const cfgInput = useRef<HTMLInputElement>(null);
  const [secrets, setSecrets] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const importCfg = useMut((cfg: unknown) => api<{ providers: number; upstreamKeys: number; models: number; aliases: number; gatewayKeys: number; skipped: string[] }>('config/import', { method: 'POST', json: cfg }), CONFIG_KEYS);

  const restore = async (file: File) => {
    if (!window.confirm('Restore this backup? The current database is kept as a .bak file, and the backup takes effect after you restart the gateway.')) return;
    setBusy('restore');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ message: string }>('settings/restore', { method: 'POST', body: fd });
      toast.ok(r.message);
    } catch (e) {
      toast.err(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Backup & transfer">
      <div className="space-y-5">
        <div>
          <h3 className="text-sm font-medium">Database backup</h3>
          <p className="mb-2 mt-0.5 text-sm text-muted">A full copy: config, encrypted keys, logs and usage. Restoring it needs the same GATEWAY_MASTER_KEY from your .env.</p>
          <div className="flex flex-wrap gap-2">
            <a href="/admin/api/settings/backup" download><Button icon={<Download className="size-4" />}>Download backup</Button></a>
            <Button icon={<Upload className="size-4" />} loading={busy === 'restore'} onClick={() => dbInput.current?.click()}>Restore backup…</Button>
            <input ref={dbInput} type="file" accept=".db,.sqlite,application/octet-stream" hidden onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
          </div>
        </div>
        <div className="border-t border-border pt-5">
          <h3 className="text-sm font-medium">Config export / import (JSON)</h3>
          <p className="mb-2 mt-0.5 text-sm text-muted">Providers, models, prices, aliases, gateway keys and settings — no logs. Import merges by name, so it is safe to run twice.</p>
          <label className="mb-3 flex items-start gap-2 text-sm">
            <Switch checked={secrets} onChange={setSecrets} label="Include secrets" />
            <span>Include secrets<br /><span className="text-xs text-warn">The file will contain your provider API keys in plain text. Store it like a password.</span></span>
          </label>
          <div className="flex flex-wrap gap-2">
            <a href={`/admin/api/config/export${secrets ? '?includeSecrets=1' : ''}`} download="gateway-config.json"><Button icon={<Download className="size-4" />}>Export config</Button></a>
            <Button icon={<Upload className="size-4" />} loading={importCfg.isPending} onClick={() => cfgInput.current?.click()}>Import config…</Button>
            <input
              ref={cfgInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                let cfg: unknown;
                try {
                  cfg = JSON.parse(await file.text());
                } catch {
                  return toast.err('That file is not valid JSON');
                }
                importCfg.mutate(cfg, {
                  onSuccess: (r) => toast.ok(`Imported ${r.providers} providers, ${r.upstreamKeys} keys, ${r.models} models, ${r.aliases} aliases, ${r.gatewayKeys} gateway keys${r.skipped.length ? ` · ${r.skipped.length} skipped` : ''}`),
                  onError: toast.err,
                });
              }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Defaults, security and backups." />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-6">
          <GeneralSettings />
          <PasswordCard />
        </div>
        <BackupCard />
      </div>
    </>
  );
}
