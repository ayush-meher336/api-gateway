import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { CONFIG_KEYS, useMut } from '../../lib/queries';
import { DEFAULT_BASE_URLS, PROVIDER_LABELS, PROVIDER_TYPES, type Provider, type ProviderType } from '../../lib/types';
import { useToast } from '../toast';
import { Button, Dialog, ErrorNote, Field, Input, NumberInput, Select, Switch } from '../ui';

export function ProviderForm({ open, onClose, provider }: { open: boolean; onClose: () => void; provider?: Provider }) {
  const toast = useToast();
  const [type, setType] = useState<ProviderType>(provider?.type ?? 'openai');
  const [name, setName] = useState(provider?.name ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? DEFAULT_BASE_URLS.openai);
  const [timeoutS, setTimeoutS] = useState<number | null>(provider ? provider.timeoutMs / 1000 : 120);
  const [priority, setPriority] = useState<number | null>(provider?.priority ?? 0);
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [headers, setHeaders] = useState<[string, string][]>(Object.entries(provider?.extraHeaders ?? {}));

  const save = useMut(
    () => {
      const body = {
        name: name.trim(),
        type,
        baseUrl: baseUrl.trim() || undefined,
        timeoutMs: Math.round((timeoutS ?? 120) * 1000),
        priority: priority ?? 0,
        enabled,
        extraHeaders: Object.fromEntries(headers.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
      };
      return provider ? api(`providers/${provider.id}`, { method: 'PATCH', json: body }) : api('providers', { method: 'POST', json: body });
    },
    CONFIG_KEYS,
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={provider ? `Edit ${provider.name}` : 'Add provider'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name.trim() || (type === 'custom_openai' && !baseUrl.trim())}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: () => {
                  toast.ok(provider ? 'Provider saved' : 'Provider added — now add its API keys');
                  onClose();
                },
              })
            }
          >
            {provider ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Provider type">
          <Select
            value={type}
            disabled={!!provider}
            onChange={(e) => {
              const t = e.target.value as ProviderType;
              setType(t);
              if (!provider) {
                setBaseUrl(DEFAULT_BASE_URLS[t]);
                setName(t === 'custom_openai' ? '' : t);
              }
            }}
          >
            {PROVIDER_TYPES.map((t) => (
              <option key={t} value={t}>{PROVIDER_LABELS[t]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Name" hint="Used in model ids, e.g. name/gpt-4o. Letters, digits, dot, dash, underscore.">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-provider" />
        </Field>
        <Field label="Base URL" hint={type === 'custom_openai' ? 'Any OpenAI-compatible endpoint, ending before /chat/completions.' : 'Pre-filled with the official endpoint.'}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Timeout (seconds)" hint="Time to first byte, and max idle gap while streaming.">
            <NumberInput value={timeoutS} onChange={setTimeoutS} placeholder="120" min={1} />
          </Field>
          <Field label="Priority" hint="Lower is preferred for bare model ids.">
            <NumberInput value={priority} onChange={setPriority} placeholder="0" step={1} />
          </Field>
        </div>
        <Field label="Extra headers" hint="Sent with every request to this provider (e.g. HTTP-Referer for OpenRouter).">
          <div className="space-y-2">
            {headers.map(([k, v], i) => (
              <div key={i} className="flex gap-2">
                <Input value={k} placeholder="Header" onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [e.target.value, h[1]] : h)))} />
                <Input value={v} placeholder="Value" onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [h[0], e.target.value] : h)))} />
                <Button variant="ghost" aria-label="Remove header" onClick={() => setHeaders(headers.filter((_, j) => j !== i))} icon={<Trash2 className="size-4" />} />
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setHeaders([...headers, ['', '']])}>
              Add header
            </Button>
          </div>
        </Field>
        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
          <span className="text-sm">Enabled</span>
          <Switch checked={enabled} onChange={setEnabled} label="Enabled" />
        </div>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}
