import type { FastifyInstance } from 'fastify';
import type { Services } from '../services.js';
import type { GatewayKey } from '../db/types.js';
import type { ConfigSnapshot } from '../router/snapshot.js';
import { GatewayError } from '../errors.js';
import { authenticate } from './auth.js';
import { handleProxy } from './pipeline.js';

/** Model ids a key can call: allowed aliases plus allowed `provider/model` ids. */
export function listAllowedModels(gk: GatewayKey, snap: ConfigSnapshot) {
  const out: { id: string; object: 'model'; created: number; owned_by: string }[] = [];
  const modelOk = (modelId: number) => {
    const m = snap.models.get(modelId);
    const p = m && snap.providers.get(m.providerId);
    if (!m || !m.enabled || !p || !p.enabled) return false;
    if (gk.allowedProviderIds && !gk.allowedProviderIds.includes(p.id)) return false;
    if (gk.allowedModelIds && !gk.allowedModelIds.includes(m.id)) return false;
    return true;
  };
  for (const a of snap.aliasesByName.values()) {
    if (!a.enabled || (gk.allowedAliases && !gk.allowedAliases.includes(a.name))) continue;
    if (a.targets.some((t) => t.enabled && modelOk(t.modelId))) out.push({ id: a.name, object: 'model', created: 0, owned_by: 'gateway' });
  }
  if (!gk.allowedAliases || gk.allowedModelIds !== null) {
    for (const m of snap.models.values()) {
      if (!modelOk(m.id)) continue;
      const p = snap.providers.get(m.providerId)!;
      out.push({ id: `${p.name}/${m.upstreamModelId}`, object: 'model', created: 0, owned_by: p.name });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function registerProxyRoutes(app: FastifyInstance, s: Services) {
  const route = (url: string, endpoint: 'chat' | 'completions' | 'embeddings' | 'messages') =>
    app.post(url, async (req, reply) => {
      await handleProxy(endpoint, req, reply, s);
      return reply;
    });
  route('/v1/chat/completions', 'chat');
  route('/v1/completions', 'completions');
  route('/v1/embeddings', 'embeddings');
  route('/v1/messages', 'messages');

  app.get('/v1/models', async (req, reply) => {
    try {
      const gk = authenticate(req, s);
      return { object: 'list', data: listAllowedModels(gk, s.snapshots.get()) };
    } catch (err) {
      if (err instanceof GatewayError) return reply.code(err.status).send(err.toBody());
      throw err;
    }
  });
}
