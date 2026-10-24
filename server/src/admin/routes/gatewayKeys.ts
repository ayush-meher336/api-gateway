import { generateGatewayKey } from '../../crypto/gatewayKey.js';
import type { GatewayKey } from '../../db/types.js';
import { must, type AdminContext } from '../context.js';
import { gatewayKeyCreate, gatewayKeyUpdate, idParam } from '../schemas.js';
import { emptyStats, last24hBy } from '../stats.js';

export function gatewayKeyRoutes({ app, s }: AdminContext) {
  const r = s.repos;

  const withUsage = (k: GatewayKey, stats = last24hBy(s.db, 'gateway_key_id')) => ({
    ...k,
    last24h: stats.get(k.id) ?? emptyStats(),
    spend: s.usage.gatewaySpend(k.id),
  });

  app.get('/gateway-keys', async () => {
    s.usage.clear();
    const stats = last24hBy(s.db, 'gateway_key_id');
    return r.gatewayKeys.list().map((k) => withUsage(k, stats));
  });

  app.get('/gateway-keys/:id', async (req) => withUsage(must(r.gatewayKeys.get(idParam.parse(req.params).id), 'Gateway key')));

  app.post('/gateway-keys', async (req) => {
    const body = gatewayKeyCreate.parse(req.body);
    const k = generateGatewayKey();
    const created = r.gatewayKeys.create({
      maxRetries: r.settings.get('defaultMaxRetries', 3),
      ...body,
      keyHash: k.hash,
      keyPrefix: k.prefix,
    });
    return { ...created, key: k.plain };
  });

  app.patch('/gateway-keys/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.gatewayKeys.get(id), 'Gateway key');
    return r.gatewayKeys.update(id, gatewayKeyUpdate.parse(req.body));
  });

  app.post('/gateway-keys/:id/regenerate', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.gatewayKeys.get(id), 'Gateway key');
    const k = generateGatewayKey();
    return { ...r.gatewayKeys.update(id, { keyHash: k.hash, keyPrefix: k.prefix }), key: k.plain };
  });

  app.delete('/gateway-keys/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    must(r.gatewayKeys.get(id), 'Gateway key');
    r.gatewayKeys.delete(id);
    return { ok: true };
  });
}
