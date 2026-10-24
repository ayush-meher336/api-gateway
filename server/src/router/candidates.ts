import type { GatewayKey, Model, Provider, UpstreamKey } from '../db/types.js';
import type { ConfigSnapshot } from './snapshot.js';
import type { Target } from './resolve.js';

export interface Candidate {
  provider: Provider;
  model: Model;
  key: UpstreamKey;
  targetWeight: number;
  targetPriority: number;
}

export interface KeyAvailability {
  allows(key: UpstreamKey): boolean;
}

function inPool(gk: GatewayKey, k: UpstreamKey): boolean {
  const pool = gk.pool;
  switch (pool.mode) {
    case 'all':
      return true;
    case 'explicit':
      return pool.keyIds.includes(k.id);
    case 'tags':
      return k.tags.some((t) => pool.tags.includes(t));
    case 'providers':
      return pool.providerIds.includes(k.providerId);
    default:
      return false;
  }
}

export function keyUsable(k: UpstreamKey, now: number): boolean {
  if (k.status === 'active') return true;
  return k.status === 'cooldown' && (k.cooldownUntil ?? 0) <= now;
}

/** Every (target, key) pair this gateway key may use right now. Keys are ordered by id within a target. */
export function buildCandidates(gk: GatewayKey, targets: Target[], snap: ConfigSnapshot, now: number, avail: KeyAvailability): Candidate[] {
  const out: Candidate[] = [];
  for (const t of targets) {
    const provider = snap.providers.get(t.model.providerId);
    if (!provider || !provider.enabled) continue;
    for (const key of snap.keysByProvider.get(provider.id) ?? []) {
      if (!inPool(gk, key) || !keyUsable(key, now) || !avail.allows(key)) continue;
      out.push({ provider, model: t.model, key, targetWeight: t.weight, targetPriority: t.priority });
    }
  }
  return out;
}

/** Soonest time any pool key for these targets comes out of cooldown (for the 503 message). */
export function soonestCooldown(gk: GatewayKey, targets: Target[], snap: ConfigSnapshot): number | null {
  let best: number | null = null;
  for (const t of targets) {
    for (const k of snap.keysByProvider.get(t.model.providerId) ?? []) {
      if (k.status === 'cooldown' && inPool(gk, k) && k.cooldownUntil && (best === null || k.cooldownUntil < best)) best = k.cooldownUntil;
    }
  }
  return best;
}
