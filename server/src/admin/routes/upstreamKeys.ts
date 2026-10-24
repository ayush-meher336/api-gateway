import { z } from 'zod';
import { getAdapter } from '../../adapters/registry.js';
import { badRequest, must, type AdminContext } from '../context.js';
import { idParam, upstreamKeysBulk, upstreamKeyUpdate } from '../schemas.js';
import { emptyStats, last24hBy } from '../stats.js';

export function upstreamKeyRoutes({ app, s }: AdminContext) {
  const r = s.repos;

  app.get('/upstream-keys', async (req) => {
    const { providerId } = z.object({ providerId: z.coerce.number().int().optional() }).parse(req.query);
    const stats = last24hBy(s.db, 'upstream_key_id');
    return r.upstreamKeys.list(providerId).map((k) => ({ ...k, last24h: stats.get(k.id) ?? emptyStats() }));
  });

  app.post('/upstream-keys/bulk', async (req) => {
    const { providerId, secrets, ...defaults } = upstreamKeysBulk.parse(req.body);
    must(r.providers.get(providerId), 'Provider');
    const list = Array.isArray(secrets) ? secrets : secrets.split(/[\r\n,]+/);
    const res = r.upstreamKeys.createMany(providerId, list, defaults);
    if (!res.created.length && !res.duplicates) throw badRequest('no_secrets', 'Paste at least one key');
    s.snapshots.invalidate();
    return { created: res.created.length, duplicates: res.duplicates, keys: res.created };
  });

  app.patch('/upstream-keys/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.upstreamKeys.get(id), 'Upstream key');
    const patch = upstreamKeyUpdate.parse(req.body);
    const k = r.upstreamKeys.update(id, patch.status === 'active' ? { ...patch, cooldownUntil: null, failStreak: 0 } : patch);
    s.snapshots.invalidate();
    return k;
  });

  app.delete('/upstream-keys/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.upstreamKeys.get(id), 'Upstream key');
    r.upstreamKeys.delete(id);
    s.snapshots.invalidate();
    return { ok: true };
  });

  app.post('/upstream-keys/:id/reset', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.upstreamKeys.get(id), 'Upstream key');
    s.setKeyStatus(id, 'active', { cooldownUntil: null, lastError: null, failStreak: 0 });
    return r.upstreamKeys.get(id);
  });

  /** Checks a key by listing models with it; a passing key is reactivated. */
  app.post('/upstream-keys/:id/test', async (req) => {
    const { id } = idParam.parse(req.params);
    const k = must(r.upstreamKeys.get(id), 'Upstream key');
    const p = must(r.providers.get(k.providerId), 'Provider');
    const t0 = Date.now();
    try {
      const models = await getAdapter(p.type).listModels(p, r.upstreamKeys.getSecret(id), s.fetchFn);
      if (k.status !== 'disabled') s.setKeyStatus(id, 'active', { cooldownUntil: null, lastError: null, failStreak: 0 });
      return { ok: true, models: models.length, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: (err as Error).message, latencyMs: Date.now() - t0 };
    }
  });
}
