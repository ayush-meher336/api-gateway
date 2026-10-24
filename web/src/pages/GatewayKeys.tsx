import { Activity, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GatewayKeyWizard } from '../components/forms/GatewayKeyWizard';
import { KeyReveal } from '../components/KeyReveal';
import { useToast } from '../components/toast';
import { Badge, Button, Card, Empty, ErrorNote, Mono, PageHeader, Spinner, Switch, T } from '../components/ui';
import { api } from '../lib/api';
import { fmtAgo, fmtNum, fmtUsd } from '../lib/format';
import { useGatewayKeys, useMut } from '../lib/queries';
import { STRATEGY_INFO, type GatewayKey } from '../lib/types';

export function poolSummary(k: GatewayKey): string {
  const p = k.pool;
  if (p.mode === 'all') return 'All keys';
  if (p.mode === 'explicit') return `${p.keyIds.length} picked key${p.keyIds.length === 1 ? '' : 's'}`;
  if (p.mode === 'tags') return `Tags: ${p.tags.join(', ')}`;
  return `${p.providerIds.length} provider${p.providerIds.length === 1 ? '' : 's'}`;
}

export function GatewayKeys() {
  const q = useGatewayKeys();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const toggle = useMut((k: GatewayKey) => api(`gateway-keys/${k.id}`, { method: 'PATCH', json: { enabled: !k.enabled } }), [['gateway-keys']]);
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Gateway keys"
        subtitle="The keys your apps use. Each one decides which providers, keys and models it may use and how calls rotate."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Create key</Button>}
      />
      <ErrorNote error={q.error} />
      <Card pad={false}>
        {q.isLoading ? (
          <div className="grid h-40 place-items-center"><Spinner /></div>
        ) : !q.data?.length ? (
          <Empty icon={<Activity className="size-8" />} title="No gateway keys yet" action={<Button variant="primary" onClick={() => setCreating(true)}>Create your first key</Button>}>
            One gateway key can rotate through every upstream key you've added — or just a hand-picked subset.
          </Empty>
        ) : (
          <div className={T.wrap}>
            <table className={T.table}>
              <thead>
                <tr>
                  <th className={T.th}>Name</th>
                  <th className={T.th}>Pool</th>
                  <th className={T.th}>Routing</th>
                  <th className={T.th}>Requests 24h</th>
                  <th className={T.th}>Spend today / month</th>
                  <th className={T.th}>Last used</th>
                  <th className={T.th}>Enabled</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((k) => (
                  <tr key={k.id} className={T.row}>
                    <td className={T.td}>
                      <Link to={`/gateway-keys/${k.id}`} className="whitespace-nowrap font-medium hover:text-accent">{k.name}</Link>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <Mono>{k.keyPrefix}…</Mono>
                        {k.expiresAt && k.expiresAt < now && <Badge tone="err">expired</Badge>}
                        {k.expiresAt && k.expiresAt >= now && <Badge tone="warn">expires {new Date(k.expiresAt).toLocaleDateString()}</Badge>}
                      </div>
                    </td>
                    <td className={`${T.td} text-muted`}>{poolSummary(k)}</td>
                    <td className={T.td}>{STRATEGY_INFO[k.strategy].label}</td>
                    <td className={`${T.td} tabular`}>
                      {fmtNum(k.last24h.requests)}
                      {k.last24h.errors > 0 && <span className="ml-1.5 text-xs text-err">{fmtNum(k.last24h.errors)} err</span>}
                    </td>
                    <td className={`${T.td} tabular`}>
                      {fmtUsd(k.spend.dayUsd)}
                      {k.budgetDailyUsd != null && <span className="text-muted"> / {fmtUsd(k.budgetDailyUsd)}</span>}
                      <span className="mx-1 text-muted">·</span>
                      {fmtUsd(k.spend.monthUsd)}
                      {k.budgetMonthlyUsd != null && <span className="text-muted"> / {fmtUsd(k.budgetMonthlyUsd)}</span>}
                    </td>
                    <td className={`${T.td} text-muted`}>{fmtAgo(k.lastUsedAt)}</td>
                    <td className={T.td}><Switch checked={k.enabled} onChange={() => toggle.mutate(k, { onError: toast.err })} label="Enabled" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <GatewayKeyWizard onClose={() => setCreating(false)} onCreated={(k) => k.key && setRevealed(k.key)} />}
      {revealed && <KeyReveal secret={revealed} onClose={() => setRevealed(null)} />}
    </>
  );
}
