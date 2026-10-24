import { z } from 'zod';
import { badRequest, must, type AdminContext } from '../context.js';
import { aliasCreate, aliasUpdate, idParam, modelCreate, modelUpdate } from '../schemas.js';
import { emptyStats, last24hBy } from '../stats.js';

export function modelRoutes({ app, s }: AdminContext) {
  const r = s.repos;

  app.get('/models', async (req) => {
    const { providerId } = z.object({ providerId: z.coerce.number().int().optional() }).parse(req.query);
    const stats = last24hBy(s.db, 'model_id');
    return r.models.list(providerId).map((m) => ({ ...m, last24h: stats.get(m.id) ?? emptyStats() }));
  });

  app.post('/models', async (req) => {
    const body = modelCreate.parse(req.body);
    must(r.providers.get(body.providerId), 'Provider');
    const m = r.models.create(body);
    s.snapshots.invalidate();
    return m;
  });

  app.patch('/models/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.models.get(id), 'Model');
    const m = r.models.update(id, modelUpdate.parse(req.body));
    s.snapshots.invalidate();
    return m;
  });

  app.delete('/models/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.models.get(id), 'Model');
    r.models.delete(id);
    s.snapshots.invalidate();
    return { ok: true };
  });

  const checkTargets = (targets: { modelId: number }[] | undefined) => {
    for (const t of targets ?? []) if (!r.models.get(t.modelId)) throw badRequest('unknown_model', `Model ${t.modelId} does not exist`);
  };

  app.get('/aliases', async () => r.aliases.list());

  app.post('/aliases', async (req) => {
    const body = aliasCreate.parse(req.body);
    checkTargets(body.targets);
    const a = r.aliases.create(body);
    s.snapshots.invalidate();
    return a;
  });

  app.patch('/aliases/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.aliases.get(id), 'Alias');
    const body = aliasUpdate.parse(req.body);
    checkTargets(body.targets);
    const a = r.aliases.update(id, body);
    s.snapshots.invalidate();
    return a;
  });

  app.delete('/aliases/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.aliases.get(id), 'Alias');
    r.aliases.delete(id);
    s.snapshots.invalidate();
    return { ok: true };
  });
}
