import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../../src/db/client.js';
import { createRepos, type Repos } from '../../src/db/repos/index.js';
import { loadSnapshot, type ConfigSnapshot } from '../../src/router/snapshot.js';
import { resolveTargets } from '../../src/router/resolve.js';
import { buildCandidates } from '../../src/router/candidates.js';
import { GatewayError } from '../../src/errors.js';
import type { GatewayKey } from '../../src/db/types.js';

let repos: Repos;
let ids: { p1: number; p2: number; m1: number; m2: number; keys1: number[]; keys2: number[] };
const allow = { allows: () => true };

function gk(over: Partial<GatewayKey> = {}): GatewayKey {
  return repos.gatewayKeys.update(repos.gatewayKeys.create({ name: 'g', keyHash: Math.random().toString(), keyPrefix: 'gw' }).id, over as any);
}
const snap = (): ConfigSnapshot => loadSnapshot(repos);

beforeEach(() => {
  repos = createRepos(openDb(':memory:'), randomBytes(32));
  const p1 = repos.providers.create({ name: 'openai', type: 'openai', baseUrl: 'u' }).id;
  const p2 = repos.providers.create({ name: 'openrouter', type: 'openrouter', baseUrl: 'u' }).id;
  repos.models.upsertSynced(p1, [{ upstreamModelId: 'gpt-4o' }]);
  repos.models.upsertSynced(p2, [{ upstreamModelId: 'openai/gpt-4o' }]);
  const m1 = repos.models.list(p1)[0].id;
  const m2 = repos.models.list(p2)[0].id;
  const keys1 = repos.upstreamKeys.createMany(p1, ['a1', 'a2', 'a3'], { tags: ['p1'] }).created.map((k) => k.id);
  const keys2 = repos.upstreamKeys.createMany(p2, ['b1', 'b2', 'b3'], { tags: ['p3'] }).created.map((k) => k.id);
  repos.aliases.create({ name: 'gpt-4o', targets: [{ modelId: m1 }, { modelId: m2, priority: 1 }] });
  ids = { p1, p2, m1, m2, keys1, keys2 };
});

describe('resolveTargets', () => {
  it('resolves an alias to all its targets', () => {
    const r = resolveTargets('gpt-4o', gk(), snap());
    expect(r.aliasId).not.toBeNull();
    expect(r.targets.map((t) => t.model.id).sort()).toEqual([ids.m1, ids.m2].sort());
  });

  it('resolves provider/model direct ids', () => {
    const r = resolveTargets('openrouter/openai/gpt-4o', gk(), snap());
    expect(r.aliasId).toBeNull();
    expect(r.targets.map((t) => t.model.id)).toEqual([ids.m2]);
  });

  it('provider/model wins over a bare upstream id that looks the same', () => {
    expect(resolveTargets('openai/gpt-4o', gk(), snap()).targets.map((t) => t.model.id)).toEqual([ids.m1]);
  });

  it('falls back to a bare upstream id across providers', () => {
    const r = resolveTargets('openai/gpt-4o', gk({ allowedProviderIds: [ids.p2] }), snap());
    expect(r.targets.map((t) => t.model.id)).toEqual([ids.m2]);
  });

  it('applies alias / provider scope', () => {
    expect(() => resolveTargets('gpt-4o', gk({ allowedAliases: ['other'] }), snap())).toThrow(GatewayError);
    const r = resolveTargets('gpt-4o', gk({ allowedProviderIds: [ids.p2] }), snap());
    expect(r.targets.map((t) => t.model.id)).toEqual([ids.m2]);
  });

  it('throws 404 model_not_allowed for unknown models', () => {
    try {
      resolveTargets('nope', gk(), snap());
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).status).toBe(404);
      expect((e as GatewayError).code).toBe('model_not_allowed');
    }
  });
});

describe('buildCandidates', () => {
  it('crosses alias targets with pool keys of the matching provider', () => {
    const k = gk();
    const s = snap();
    const c = buildCandidates(k, resolveTargets('gpt-4o', k, s).targets, s, Date.now(), allow);
    expect(c).toHaveLength(6);
    expect(c.every((x) => x.key.providerId === x.provider.id)).toBe(true);
  });

  it('tags pool selects only tagged keys', () => {
    const k = gk({ pool: { mode: 'tags', tags: ['p3'] } });
    const s = snap();
    const c = buildCandidates(k, resolveTargets('gpt-4o', k, s).targets, s, Date.now(), allow);
    expect(c.map((x) => x.key.id).sort()).toEqual([...ids.keys2].sort());
  });

  it('explicit and providers pools', () => {
    const s = snap();
    let k = gk({ pool: { mode: 'explicit', keyIds: [ids.keys1[0], ids.keys2[2]] } });
    expect(buildCandidates(k, resolveTargets('gpt-4o', k, s).targets, s, Date.now(), allow).map((x) => x.key.id)).toEqual([ids.keys1[0], ids.keys2[2]]);
    k = gk({ pool: { mode: 'providers', providerIds: [ids.p1] } });
    expect(buildCandidates(k, resolveTargets('gpt-4o', k, s).targets, s, Date.now(), allow)).toHaveLength(3);
  });

  it('skips disabled and dangling refs', () => {
    repos.providers.update(ids.p1, { enabled: false });
    repos.upstreamKeys.setStatus(ids.keys2[0], 'invalid');
    repos.upstreamKeys.setStatus(ids.keys2[1], 'disabled');
    const k = gk({ pool: { mode: 'explicit', keyIds: [...ids.keys1, ...ids.keys2, 9999] } });
    const s = snap();
    const c = buildCandidates(k, resolveTargets('gpt-4o', k, s).targets, s, Date.now(), allow);
    expect(c.map((x) => x.key.id)).toEqual([ids.keys2[2]]);
  });

  it('disabled model in alias is dropped', () => {
    repos.models.update(ids.m2, { enabled: false });
    const k = gk();
    const s = snap();
    expect(resolveTargets('gpt-4o', k, s).targets.map((t) => t.model.id)).toEqual([ids.m1]);
  });

  it('includes keys whose cooldown expired, excludes active cooldowns and limited keys', () => {
    const now = Date.now();
    repos.upstreamKeys.setStatus(ids.keys1[0], 'cooldown', { cooldownUntil: now - 1 });
    repos.upstreamKeys.setStatus(ids.keys1[1], 'cooldown', { cooldownUntil: now + 60_000 });
    const k = gk({ pool: { mode: 'providers', providerIds: [ids.p1] } });
    const s = snap();
    const limited = { allows: (key: { id: number }) => key.id !== ids.keys1[2] };
    const c = buildCandidates(k, resolveTargets('gpt-4o', k, s).targets, s, now, limited);
    expect(c.map((x) => x.key.id)).toEqual([ids.keys1[0]]);
  });
});

describe('scope error messages', () => {
  it('says the key access settings excluded an existing alias', () => {
    try {
      resolveTargets('gpt-4o', gk({ allowedProviderIds: [9999] }), snap());
      expect.unreachable();
    } catch (e) {
      expect((e as GatewayError).code).toBe('model_not_allowed');
      expect((e as GatewayError).message).toMatch(/exists but this API key's access settings/);
    }
  });
  it('says the model does not exist when nothing matches at all', () => {
    expect(() => resolveTargets('no-such-model', gk(), snap())).toThrow(/No model or alias named "no-such-model"/);
  });
});
