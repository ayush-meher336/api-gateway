import { tx } from '../db/client.js';
import type { Repos } from '../db/repos/index.js';
import type { GatewayKey, KeyPool } from '../db/types.js';
import { readSettings } from './settings.js';

/** One undecryptable key (e.g. after a master key change) must not abort the whole export. */
function exportSecret(repos: Repos, id: number): { secret: string | null; secretError?: string } {
  try {
    return { secret: repos.upstreamKeys.getSecret(id) };
  } catch {
    return { secret: null, secretError: 'decrypt_failed' };
  }
}

/**
 * Portable config. Cross-references use names (provider), `provider/upstreamModelId` (model)
 * and export refs (upstream key), so a file imports cleanly into a database with different ids.
 */
export function exportConfig(repos: Repos, includeSecrets: boolean) {
  const providers = repos.providers.list();
  const pName = new Map(providers.map((p) => [p.id, p.name]));
  const models = repos.models.list();
  const mRef = new Map(models.map((m) => [m.id, `${pName.get(m.providerId)}/${m.upstreamModelId}`]));
  const keyHashes = new Map(
    (repos.db.prepare('SELECT id, key_hash FROM gateway_keys').all() as { id: number; key_hash: string }[]).map((r) => [r.id, r.key_hash]),
  );

  const pool = (p: KeyPool) =>
    p.mode === 'explicit' ? { mode: 'explicit', keyRefs: p.keyIds } : p.mode === 'providers' ? { mode: 'providers', providers: p.providerIds.map((id) => pName.get(id)).filter(Boolean) } : p;

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    includesSecrets: includeSecrets,
    settings: readSettings(repos),
    providers: providers.map(({ id: _id, createdAt: _c, ...p }) => p),
    upstreamKeys: repos.upstreamKeys.list().map((k) => ({
      ref: k.id,
      provider: pName.get(k.providerId),
      label: k.label,
      tags: k.tags,
      weight: k.weight,
      rpmLimit: k.rpmLimit,
      tpmLimit: k.tpmLimit,
      dailyRequestCap: k.dailyRequestCap,
      dailyTokenCap: k.dailyTokenCap,
      disabled: k.status === 'disabled',
      ...(includeSecrets ? exportSecret(repos, k.id) : {}),
    })),
    models: models.map(({ id: _id, providerId, ...m }) => ({ provider: pName.get(providerId), ...m })),
    aliases: repos.aliases.list().map((a) => ({
      name: a.name,
      description: a.description,
      enabled: a.enabled,
      targets: a.targets.map((t) => ({ model: mRef.get(t.modelId), weight: t.weight, priority: t.priority, enabled: t.enabled })),
    })),
    gatewayKeys: repos.gatewayKeys.list().map(({ id, createdAt: _c, lastUsedAt: _l, allowedModelIds, allowedProviderIds, pool: p, ...g }) => ({
      ...g,
      allowedModels: allowedModelIds?.map((m) => mRef.get(m)).filter(Boolean) ?? null,
      allowedProviders: allowedProviderIds?.map((x) => pName.get(x)).filter(Boolean) ?? null,
      pool: pool(p),
      ...(includeSecrets ? { keyHash: keyHashes.get(id) } : {}),
    })),
  };
}

export interface ImportResult {
  providers: number;
  upstreamKeys: number;
  models: number;
  aliases: number;
  gatewayKeys: number;
  skipped: string[];
}

/** Idempotent merge: existing rows (matched by name / secret / key hash) are updated, the rest created. */
export function importConfig(repos: Repos, cfg: any): ImportResult {
  if (!cfg || cfg.version !== 1) throw new Error('Unsupported config file (expected version 1)');
  const res: ImportResult = { providers: 0, upstreamKeys: 0, models: 0, aliases: 0, gatewayKeys: 0, skipped: [] };
  return tx(repos.db, () => {
    const pid = new Map<string, number>();
    for (const p of cfg.providers ?? []) {
      const existing = repos.providers.list().find((x) => x.name === p.name);
      const row = existing ? repos.providers.update(existing.id, p) : repos.providers.create(p);
      pid.set(row.name, row.id);
      res.providers++;
    }

    const keyRef = new Map<number, number>();
    for (const k of cfg.upstreamKeys ?? []) {
      const providerId = pid.get(k.provider);
      if (!providerId || !k.secret) {
        res.skipped.push(`upstream key ${k.label ?? k.ref}: ${k.secret ? 'unknown provider' : 'no secret in file'}`);
        continue;
      }
      const meta = { label: k.label, tags: k.tags ?? [], weight: k.weight ?? 1, rpmLimit: k.rpmLimit ?? null, tpmLimit: k.tpmLimit ?? null, dailyRequestCap: k.dailyRequestCap ?? null, dailyTokenCap: k.dailyTokenCap ?? null };
      let id = repos.upstreamKeys.findIdBySecret(providerId, k.secret);
      if (id) repos.upstreamKeys.update(id, meta);
      else id = repos.upstreamKeys.createMany(providerId, [k.secret], meta).created[0].id;
      if (k.disabled) repos.upstreamKeys.setStatus(id, 'disabled');
      keyRef.set(k.ref, id);
      res.upstreamKeys++;
    }

    const mid = new Map<string, number>();
    for (const { provider, ...m } of cfg.models ?? []) {
      const providerId = pid.get(provider);
      if (!providerId) continue;
      const existing = repos.models.list(providerId).find((x) => x.upstreamModelId === m.upstreamModelId);
      const row = existing ? repos.models.update(existing.id, m) : repos.models.create({ ...m, providerId });
      mid.set(`${provider}/${m.upstreamModelId}`, row.id);
      res.models++;
    }

    for (const a of cfg.aliases ?? []) {
      const targets = (a.targets ?? [])
        .filter((t: any) => mid.has(t.model))
        .map((t: any) => ({ modelId: mid.get(t.model)!, weight: t.weight, priority: t.priority, enabled: t.enabled }));
      const existing = repos.aliases.list().find((x) => x.name === a.name);
      const body = { name: a.name, description: a.description ?? null, enabled: a.enabled ?? true, targets };
      if (existing) repos.aliases.update(existing.id, body);
      else repos.aliases.create(body);
      res.aliases++;
    }

    for (const g of cfg.gatewayKeys ?? []) {
      if (!g.keyHash) {
        res.skipped.push(`gateway key ${g.name}: exported without secrets`);
        continue;
      }
      const { allowedModels, allowedProviders, pool, keyHash, keyPrefix, ...rest } = g;
      const mapIds = (names: string[] | null, map: Map<string, number>) => (names ? names.map((n) => map.get(n)).filter((x): x is number => !!x) : null);
      let newPool: KeyPool = { mode: 'all' };
      if (pool?.mode === 'explicit') newPool = { mode: 'explicit', keyIds: (pool.keyRefs ?? []).map((r: number) => keyRef.get(r)).filter(Boolean) };
      else if (pool?.mode === 'providers') newPool = { mode: 'providers', providerIds: mapIds(pool.providers, pid) ?? [] };
      else if (pool?.mode === 'tags') newPool = { mode: 'tags', tags: pool.tags ?? [] };
      const body: Partial<GatewayKey> & { name: string } = {
        ...rest,
        pool: newPool,
        allowedModelIds: mapIds(allowedModels, mid),
        allowedProviderIds: mapIds(allowedProviders, pid),
      };
      const existing = repos.gatewayKeys.findByHash(keyHash);
      if (existing) repos.gatewayKeys.update(existing.id, body);
      else repos.gatewayKeys.create({ ...body, keyHash, keyPrefix });
      res.gatewayKeys++;
    }

    for (const [k, v] of Object.entries(cfg.settings ?? {})) {
      if (k in readSettings(repos)) repos.settings.set(k, v);
    }
    return res;
  });
}
