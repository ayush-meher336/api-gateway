import { useState } from 'react';
import { api } from '../../lib/api';
import { CONFIG_KEYS, useMut, useProviders } from '../../lib/queries';
import { useToast } from '../toast';
import { Button, Dialog, ErrorNote, Field, Input, NumberInput, Select, TagInput, Textarea } from '../ui';

export function BulkKeysDialog({ open, onClose, providerId: fixed }: { open: boolean; onClose: () => void; providerId?: number }) {
  const toast = useToast();
  const providers = useProviders();
  const [providerId, setProviderId] = useState<number | ''>(fixed ?? '');
  const [secrets, setSecrets] = useState('');
  const [label, setLabel] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [weight, setWeight] = useState<number | null>(1);
  const [rpm, setRpm] = useState<number | null>(null);
  const [tpm, setTpm] = useState<number | null>(null);
  const [dailyReq, setDailyReq] = useState<number | null>(null);
  const [dailyTok, setDailyTok] = useState<number | null>(null);
  const count = secrets.split(/[\r\n,]+/).filter((s) => s.trim()).length;
  const pid = fixed ?? (providerId || providers.data?.[0]?.id);

  const save = useMut(
    () =>
      api<{ created: number; duplicates: number }>('upstream-keys/bulk', {
        method: 'POST',
        json: { providerId: pid, secrets, label: label || undefined, tags, weight: weight ?? 1, rpmLimit: rpm, tpmLimit: tpm, dailyRequestCap: dailyReq, dailyTokenCap: dailyTok },
      }),
    CONFIG_KEYS,
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add API keys"
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!count || !pid}
            loading={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: (r) => {
                  toast.ok(`Added ${r.created} key${r.created === 1 ? '' : 's'}${r.duplicates ? ` · ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'} skipped` : ''}`);
                  setSecrets('');
                  onClose();
                },
              })
            }
          >
            Add {count || ''} key{count === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!fixed && (
          <Field label="Provider">
            <Select value={pid ?? ''} onChange={(e) => setProviderId(Number(e.target.value))}>
              {providers.data?.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="API keys" hint="One per line (commas also work). Keys are encrypted at rest and never shown again.">
          <Textarea rows={7} value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder={'sk-...\nsk-...\nsk-...'} spellCheck={false} autoComplete="off" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label" hint="Optional; numbered when adding several.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. free tier" />
          </Field>
          <Field label="Tags" hint="Gateway keys can select pools by tag.">
            <TagInput value={tags} onChange={setTags} placeholder="free, batch, team-a…" />
          </Field>
        </div>
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Per-key limits</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Weight" hint="For weighted routing.">
              <NumberInput value={weight} onChange={setWeight} placeholder="1" min={0} />
            </Field>
            <Field label="Requests / min">
              <NumberInput value={rpm} onChange={setRpm} min={1} />
            </Field>
            <Field label="Tokens / min">
              <NumberInput value={tpm} onChange={setTpm} min={1} />
            </Field>
            <Field label="Requests / day">
              <NumberInput value={dailyReq} onChange={setDailyReq} min={1} />
            </Field>
            <Field label="Tokens / day">
              <NumberInput value={dailyTok} onChange={setDailyTok} min={1} />
            </Field>
          </div>
        </details>
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
  );
}
