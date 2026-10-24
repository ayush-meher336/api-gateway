import { defaultBaseUrl, getAdapter } from '../../adapters/registry.js';
import type { Provider } from '../../db/types.js';
import { badRequest, must, type AdminContext } from '../context.js';
import { idParam, providerCreate, providerUpdate } from '../schemas.js';
import { emptyStats, last24hBy } from '../stats.js';

export function providerRoutes({ app, s }: AdminContext) {
  const r = s.repos;

  /** Lists the provider's models using its first usable key. */
  async function fetchModels(p: Provider) {
    const key = r.upstreamKeys.list(p.id).find((k) => k.status === 'active' || k.status === 'cooldown');
    if (!key && p.type !== 'ollama') throw badRequest('no_keys', 'Add at least one active key to this provider first');
    const secret = key ? r.upstreamKeys.getSecret(key.id) : '';
    return getAdapter(p.type).listModels(p, secret, s.fetchFn);
  }

  app.get('/providers', async () => {
    const stats = last24hBy(s.db, 'provider_id');
    const keys = r.upstreamKeys.list();
    const models = r.models.list();
    return r.providers.list().map((p) => ({
      ...p,
      keyCount: keys.filter((k) => k.providerId === p.id).length,
      activeKeyCount: keys.filter((k) => k.providerId === p.id && k.status === 'active').length,
      modelCount: models.filter((m) => m.providerId === p.id).length,
      last24h: stats.get(p.id) ?? emptyStats(),
    }));
  });

  app.get('/providers/:id', async (req) => must(r.providers.get(idParam.parse(req.params).id), 'Provider'));

  app.post('/providers', async (req) => {
    const body = providerCreate.parse(req.body);
    const baseUrl = body.baseUrl ?? defaultBaseUrl(body.type);
    if (!baseUrl) throw badRequest('base_url_required', 'A base URL is required for custom providers');
    const p = r.providers.create({
      ...body,
      baseUrl,
      timeoutMs: body.timeoutMs ?? r.settings.get('defaultProviderTimeoutMs', 120_000),
    });
    s.snapshots.invalidate();
    return p;
  });

  app.patch('/providers/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.providers.get(id), 'Provider');
    const p = r.providers.update(id, providerUpdate.parse(req.body));
    s.snapshots.invalidate();
    return p;
  });

  app.delete('/providers/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.providers.get(id), 'Provider');
    r.providers.delete(id);
    s.snapshots.invalidate();
    return { ok: true };
  });

  app.post('/providers/:id/test', async (req) => {
    const p = must(r.providers.get(idParam.parse(req.params).id), 'Provider');
    const t0 = Date.now();
    try {
      const models = await fetchModels(p);
      return { ok: true, models: models.length, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: (err as Error).message, latencyMs: Date.now() - t0 };
    }
  });

  app.post('/providers/:id/sync-models', async (req) => {
    const p = must(r.providers.get(idParam.parse(req.params).id), 'Provider');
    let infos;
    try {
      infos = await fetchModels(p);
    } catch (err) {
      if ((err as any).status) throw err;
      throw badRequest('sync_failed', `Could not fetch models: ${(err as Error).message}`);
    }
    const res = r.models.upsertSynced(p.id, infos);
    s.snapshots.invalidate();
    return res;
  });
}
