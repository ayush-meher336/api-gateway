import { useEffect, useState } from 'react';
import { fmtIn } from '../lib/format';
import type { UpstreamKey } from '../lib/types';
import { Badge } from './ui';

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Status pill with a live countdown for keys in cooldown. */
export function KeyStatusBadge({ k }: { k: Pick<UpstreamKey, 'status' | 'cooldownUntil' | 'lastError'> }) {
  const cooling = k.status === 'cooldown' && (k.cooldownUntil ?? 0) > Date.now();
  const now = useNow(cooling);
  if (k.status === 'invalid') return <span title={k.lastError ?? ''}><Badge tone="err">Invalid</Badge></span>;
  if (k.status === 'disabled') return <Badge>Disabled</Badge>;
  if (cooling && (k.cooldownUntil ?? 0) > now) return <span title={k.lastError ?? ''}><Badge tone="warn">Cooldown {fmtIn(k.cooldownUntil!, now)}</Badge></span>;
  return <Badge tone="ok">Active</Badge>;
}
