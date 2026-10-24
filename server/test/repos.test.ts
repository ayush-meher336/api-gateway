import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db/client.js';
import { createRepos, type Repos } from '../src/db/repos/index.js';

let repos: Repos;
beforeEach(() => {
  repos = createRepos(openDb(':memory:'), randomBytes(32));
});

describe('repos', () => {
  it('provider crud with json columns', () => {
    const p = repos.providers.create({ name: 'oa', type: 'openai', baseUrl: 'https://x', extraHeaders: { a: 'b' } });
    expect(p.id).toBeGreaterThan(0);
    expect(p.enabled).toBe(true);
    expect(p.extraHeaders).toEqual({ a: 'b' });
    const u = repos.providers.update(p.id, { enabled: false, priority: 5 });
    expect(u.enabled).toBe(false);
    expect(u.priority).toBe(5);
    expect(repos.providers.list()).toHaveLength(1);
    repos.providers.delete(p.id);
    expect(repos.providers.get(p.id)).toBeNull();
  });

  it('createMany stores encrypted secrets that list never exposes', () => {
    const p = repos.providers.create({ name: 'oa', type: 'openai', baseUrl: 'u' });
    const res = repos.upstreamKeys.createMany(p.id, ['sk-1111', 'sk-2222', '', 'sk-3333'], { tags: ['p3'] });
    expect(res.created).toHaveLength(3);
    const list = repos.upstreamKeys.list();
    expect(list).toHaveLength(3);
    expect(JSON.stringify(list)).not.toContain('sk-1111');
    expect(list[0].secretPreview).toBe('1111');
    expect(list[0].tags).toEqual(['p3']);
    expect(repos.upstreamKeys.getSecret(list[0].id)).toBe('sk-1111');
  });

  it('createMany rejects duplicates within a provider', () => {
    const p = repos.providers.create({ name: 'oa', type: 'openai', baseUrl: 'u' });
    repos.upstreamKeys.createMany(p.id, ['sk-1'], {});
    const res = repos.upstreamKeys.createMany(p.id, ['sk-1', 'sk-2', 'sk-2'], {});
    expect(res.created).toHaveLength(1);
    expect(res.duplicates).toBe(2);
  });

  it('setStatus updates cooldown fields', () => {
    const p = repos.providers.create({ name: 'oa', type: 'openai', baseUrl: 'u' });
    const [k] = repos.upstreamKeys.createMany(p.id, ['sk-1'], {}).created;
    repos.upstreamKeys.setStatus(k.id, 'cooldown', { cooldownUntil: 123, lastError: 'rate' });
    const got = repos.upstreamKeys.get(k.id)!;
    expect(got.status).toBe('cooldown');
    expect(got.cooldownUntil).toBe(123);
    expect(got.lastError).toBe('rate');
  });

  it('upsertSynced preserves manually edited prices', () => {
    const p = repos.providers.create({ name: 'oa', type: 'openai', baseUrl: 'u' });
    const r1 = repos.models.upsertSynced(p.id, [{ upstreamModelId: 'gpt-x', contextLength: 1000 }]);
    expect(r1).toEqual({ added: 1, updated: 0 });
    const m = repos.models.list()[0];
    repos.models.update(m.id, { priceInputPerM: 2.5 });
    const r2 = repos.models.upsertSynced(p.id, [{ upstreamModelId: 'gpt-x', contextLength: 2000 }, { upstreamModelId: 'gpt-y' }]);
    expect(r2).toEqual({ added: 1, updated: 1 });
    const again = repos.models.get(m.id)!;
    expect(again.priceInputPerM).toBe(2.5);
    expect(again.contextLength).toBe(2000);
    expect(again.source).toBe('synced');
  });

  it('aliases with nested targets', () => {
    const p = repos.providers.create({ name: 'oa', type: 'openai', baseUrl: 'u' });
    repos.models.upsertSynced(p.id, [{ upstreamModelId: 'a' }, { upstreamModelId: 'b' }]);
    const [ma, mb] = repos.models.list();
    const al = repos.aliases.create({ name: 'fast', targets: [{ modelId: ma.id, weight: 2 }, { modelId: mb.id, priority: 1 }] });
    expect(al.targets).toHaveLength(2);
    const up = repos.aliases.update(al.id, { targets: [{ modelId: mb.id }] });
    expect(up.targets.map((t) => t.modelId)).toEqual([mb.id]);
  });

  it('gateway key findByHash', () => {
    const gk = repos.gatewayKeys.create({ name: 'k', keyHash: 'h1', keyPrefix: 'gw-abc' });
    expect(gk.pool).toEqual({ mode: 'all' });
    expect(gk.strategy).toBe('round_robin');
    expect(repos.gatewayKeys.findByHash('h1')?.id).toBe(gk.id);
    expect(repos.gatewayKeys.findByHash('nope')).toBeNull();
  });

  it('settings default fallback and roundtrip', () => {
    expect(repos.settings.get('retentionDays', 90)).toBe(90);
    repos.settings.set('retentionDays', 30);
    expect(repos.settings.get('retentionDays', 90)).toBe(30);
  });
});
