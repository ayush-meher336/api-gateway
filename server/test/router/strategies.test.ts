import { describe, it, expect, vi, afterEach } from 'vitest';
import { orderCandidates, RouterState } from '../../src/router/strategies.js';
import { KeyLimiter } from '../../src/router/limiter.js';
import { nextCooldown } from '../../src/router/cooldown.js';
import type { Candidate } from '../../src/router/candidates.js';

function cand(keyId: number, opts: { providerId?: number; weight?: number; targetWeight?: number; priority?: number } = {}): Candidate {
  const providerId = opts.providerId ?? 1;
  return {
    provider: { id: providerId } as any,
    model: { id: providerId * 100 } as any,
    key: { id: keyId, providerId, weight: opts.weight ?? 1 } as any,
    targetWeight: opts.targetWeight ?? 1,
    targetPriority: opts.priority ?? 0,
  };
}

afterEach(() => vi.useRealTimers());

describe('round robin', () => {
  it('rotates evenly: 8 calls over 4 candidates hit each twice, in order', () => {
    const st = new RouterState();
    const cs = [cand(4), cand(2), cand(3), cand(1)];
    const firsts = Array.from({ length: 8 }, () => orderCandidates('round_robin', 7, cs, st)[0].key.id);
    expect(firsts).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it('returns the full list as failover order starting at the cursor', () => {
    const st = new RouterState();
    const cs = [cand(1), cand(2), cand(3)];
    orderCandidates('round_robin', 1, cs, st);
    expect(orderCandidates('round_robin', 1, cs, st).map((c) => c.key.id)).toEqual([2, 3, 1]);
  });

  it('keeps independent cursors per gateway key', () => {
    const st = new RouterState();
    const cs = [cand(1), cand(2)];
    expect(orderCandidates('round_robin', 1, cs, st)[0].key.id).toBe(1);
    expect(orderCandidates('round_robin', 2, cs, st)[0].key.id).toBe(1);
    expect(orderCandidates('round_robin', 1, cs, st)[0].key.id).toBe(2);
  });

  it('spreads across providers serving the same alias', () => {
    const st = new RouterState();
    const cs = [cand(1, { providerId: 1 }), cand(2, { providerId: 2 })];
    const providers = Array.from({ length: 4 }, () => orderCandidates('round_robin', 1, cs, st)[0].provider.id);
    expect(providers).toEqual([1, 2, 1, 2]);
  });

  it('cursor state can be exported and restored', () => {
    const st = new RouterState();
    orderCandidates('round_robin', 5, [cand(1), cand(2)], st);
    const st2 = new RouterState(st.exportCursors());
    expect(orderCandidates('round_robin', 5, [cand(1), cand(2)], st2)[0].key.id).toBe(2);
  });
});

describe('other strategies', () => {
  it('weighted uses key weight × target weight', () => {
    const st = new RouterState();
    const cs = [cand(1, { weight: 1 }), cand(2, { weight: 3 })];
    // total 4; rand 0.2 → 0.8 < 1 → key 1; rand 0.5 → 2.0 ≥ 1 → key 2
    expect(orderCandidates('weighted', 1, cs, st, () => 0.2)[0].key.id).toBe(1);
    expect(orderCandidates('weighted', 1, cs, st, () => 0.5)[0].key.id).toBe(2);
    expect(orderCandidates('weighted', 1, cs, st, () => 0.5)).toHaveLength(2);
  });

  it('weighted ignores zero-weight candidates for primary but keeps them for failover', () => {
    const cs = [cand(1, { weight: 0 }), cand(2, { weight: 1 })];
    const out = orderCandidates('weighted', 1, cs, new RouterState(), () => 0);
    expect(out.map((c) => c.key.id)).toEqual([2, 1]);
  });

  it('least_used picks the key with fewest recent requests', () => {
    const st = new RouterState();
    st.recordUse(1);
    st.recordUse(1);
    st.recordUse(3);
    const out = orderCandidates('least_used', 1, [cand(1), cand(2), cand(3)], st);
    expect(out.map((c) => c.key.id)).toEqual([2, 3, 1]);
  });

  it('priority_failover tries tier 0 before tier 1, round-robin within a tier', () => {
    const st = new RouterState();
    const cs = [cand(1, { priority: 1 }), cand(2, { priority: 0 }), cand(3, { priority: 0 })];
    expect(orderCandidates('priority_failover', 1, cs, st).map((c) => c.key.id)).toEqual([2, 3, 1]);
    expect(orderCandidates('priority_failover', 1, cs, st).map((c) => c.key.id)).toEqual([3, 2, 1]);
  });

  it('random returns a permutation', () => {
    const out = orderCandidates('random', 1, [cand(1), cand(2), cand(3)], new RouterState(), () => 0.99);
    expect(out.map((c) => c.key.id).sort()).toEqual([1, 2, 3]);
  });

  it('empty candidate list returns []', () => {
    for (const s of ['round_robin', 'weighted', 'least_used', 'random', 'priority_failover'] as const) {
      expect(orderCandidates(s, 1, [], new RouterState())).toEqual([]);
    }
  });
});

describe('KeyLimiter', () => {
  it('rpm=2 blocks the third call within 60s and allows after the window', () => {
    vi.useFakeTimers();
    const l = new KeyLimiter();
    expect(l.check('up', 1, { rpm: 2 })).toBe(true);
    l.record('up', 1, 10);
    l.record('up', 1, 10);
    expect(l.check('up', 1, { rpm: 2 })).toBe(false);
    expect(l.check('up', 2, { rpm: 2 })).toBe(true);
    expect(l.check('gw', 1, { rpm: 2 })).toBe(true);
    vi.advanceTimersByTime(60_001);
    expect(l.check('up', 1, { rpm: 2 })).toBe(true);
  });

  it('tpm counts tokens', () => {
    const l = new KeyLimiter();
    l.record('gw', 1, 900);
    expect(l.check('gw', 1, { tpm: 1000 })).toBe(true);
    l.record('gw', 1, 200);
    expect(l.check('gw', 1, { tpm: 1000 })).toBe(false);
    expect(l.countLast60s('gw', 1)).toEqual({ requests: 2, tokens: 1100 });
  });

  it('no limits always allows', () => {
    const l = new KeyLimiter();
    for (let i = 0; i < 100; i++) l.record('up', 1, 1000);
    expect(l.check('up', 1, {})).toBe(true);
  });
});

describe('nextCooldown', () => {
  const now = 1_000_000;
  it('honours Retry-After seconds and HTTP dates', () => {
    expect(nextCooldown('rate_limited', 1, '7', now)).toEqual({ status: 'cooldown', cooldownUntil: now + 7000 });
    const date = new Date(now + 20_000).toUTCString();
    expect(nextCooldown('rate_limited', 1, date, now).cooldownUntil).toBeGreaterThanOrEqual(now + 19_000);
  });
  it('backs off exponentially for 429 and caps at 15 minutes', () => {
    expect(nextCooldown('rate_limited', 1, undefined, now).cooldownUntil).toBe(now + 30_000);
    expect(nextCooldown('rate_limited', 3, undefined, now).cooldownUntil).toBe(now + 120_000);
    expect(nextCooldown('rate_limited', 20, undefined, now).cooldownUntil).toBe(now + 900_000);
    expect(nextCooldown('rate_limited', 1, '99999', now).cooldownUntil).toBe(now + 900_000);
  });
  it('short cooldown for server errors and invalid for auth', () => {
    expect(nextCooldown('server_error', 1, undefined, now)).toEqual({ status: 'cooldown', cooldownUntil: now + 15_000 });
    expect(nextCooldown('auth_error', 1, undefined, now)).toEqual({ status: 'invalid' });
    expect(nextCooldown('client_error', 1, undefined, now)).toBeNull();
  });
});
