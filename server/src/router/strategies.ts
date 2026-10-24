import type { Strategy } from '../db/types.js';
import type { Candidate } from './candidates.js';

const WINDOW_MS = 60_000;

/** Per-process routing state: round-robin cursors and recent per-key usage. */
export class RouterState {
  private cursors: Map<number, number>;
  private uses = new Map<number, number[]>();

  constructor(cursors: Record<string, number> = {}) {
    this.cursors = new Map(Object.entries(cursors).map(([k, v]) => [Number(k), v]));
  }

  /** Returns the cursor for a gateway key and advances it. */
  nextCursor(gkId: number): number {
    const c = this.cursors.get(gkId) ?? 0;
    this.cursors.set(gkId, (c + 1) % Number.MAX_SAFE_INTEGER);
    return c;
  }

  exportCursors(): Record<string, number> {
    return Object.fromEntries(this.cursors);
  }

  recordUse(keyId: number, now = Date.now()): void {
    const arr = this.uses.get(keyId) ?? [];
    // prune here too, or keys never routed with least_used would grow forever
    while (arr.length && arr[0] <= now - WINDOW_MS) arr.shift();
    arr.push(now);
    this.uses.set(keyId, arr);
  }

  recentUse(keyId: number, now = Date.now()): number {
    const arr = this.uses.get(keyId);
    if (!arr) return 0;
    while (arr.length && arr[0] <= now - WINDOW_MS) arr.shift();
    return arr.length;
  }
}

const stableKey = (c: Candidate) => [c.provider.id, c.key.id, c.model.id] as const;
function stableSort(cs: Candidate[]): Candidate[] {
  return [...cs].sort((a, b) => {
    const ka = stableKey(a);
    const kb = stableKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

function rotate<T>(arr: T[], start: number): T[] {
  if (!arr.length) return arr;
  const i = start % arr.length;
  return [...arr.slice(i), ...arr.slice(0, i)];
}

function weightedOrder(cs: Candidate[], rand: () => number): Candidate[] {
  const weight = (c: Candidate) => Math.max(0, (c.key.weight ?? 1) * (c.targetWeight ?? 1));
  const pool = stableSort(cs).filter((c) => weight(c) > 0);
  const zero = stableSort(cs).filter((c) => weight(c) <= 0);
  const out: Candidate[] = [];
  while (pool.length) {
    const total = pool.reduce((s, c) => s + weight(c), 0);
    const r = rand() * total;
    let acc = 0;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      acc += weight(pool[i]);
      if (acc > r) {
        idx = i;
        break;
      }
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return [...out, ...zero];
}

/** Orders candidates for one request: element 0 is the primary, the rest are the failover order. */
export function orderCandidates(strategy: Strategy, gkId: number, cs: Candidate[], state: RouterState, rand: () => number = Math.random): Candidate[] {
  if (!cs.length) return [];
  switch (strategy) {
    case 'weighted':
      return weightedOrder(cs, rand);
    case 'least_used': {
      const sorted = stableSort(cs);
      const use = new Map(sorted.map((c) => [c.key.id, state.recentUse(c.key.id)]));
      return sorted.sort((a, b) => use.get(a.key.id)! - use.get(b.key.id)!);
    }
    case 'random': {
      const a = stableSort(cs);
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
    case 'priority_failover': {
      const cursor = state.nextCursor(gkId);
      const tiers = [...new Set(cs.map((c) => c.targetPriority))].sort((a, b) => a - b);
      return tiers.flatMap((t) => rotate(stableSort(cs.filter((c) => c.targetPriority === t)), cursor));
    }
    case 'round_robin':
    default:
      return rotate(stableSort(cs), state.nextCursor(gkId));
  }
}
