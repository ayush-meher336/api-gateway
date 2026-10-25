import type { GatewayKey, Model } from '../db/types.js';
import { GatewayError } from '../errors.js';
import type { ConfigSnapshot } from './snapshot.js';

export interface Target {
  model: Model;
  weight: number;
  priority: number;
}

function modelAllowed(gk: GatewayKey, snap: ConfigSnapshot, m: Model | undefined): m is Model {
  if (!m || !m.enabled) return false;
  const p = snap.providers.get(m.providerId);
  if (!p || !p.enabled) return false;
  if (gk.allowedProviderIds && !gk.allowedProviderIds.includes(p.id)) return false;
  if (gk.allowedModelIds && !gk.allowedModelIds.includes(m.id)) return false;
  return true;
}

/**
 * Resolution order: alias name → `provider-name/upstream-id` → bare upstream id on any provider.
 * A step that yields no allowed target falls through to the next.
 */
export function resolveTargets(requested: string, gk: GatewayKey, snap: ConfigSnapshot): { aliasId: number | null; targets: Target[] } {
  if (!requested || typeof requested !== 'string') {
    throw new GatewayError(400, 'invalid_request_error', 'model_required', 'The "model" field is required');
  }

  const alias = snap.aliasesByName.get(requested);
  if (alias && alias.enabled && (!gk.allowedAliases || gk.allowedAliases.includes(alias.name))) {
    const targets = alias.targets
      .filter((t) => t.enabled)
      .map((t) => ({ model: snap.models.get(t.modelId), weight: t.weight, priority: t.priority }))
      .filter((t): t is Target => modelAllowed(gk, snap, t.model));
    if (targets.length) return { aliasId: alias.id, targets };
  }

  // With an alias allowlist, direct model access is only allowed when allowedModelIds also permits it.
  const directAllowed = !gk.allowedAliases || gk.allowedModelIds !== null;
  if (directAllowed) {
    const slash = requested.indexOf('/');
    if (slash > 0) {
      const p = snap.providersByName.get(requested.slice(0, slash).toLowerCase());
      const upstreamId = requested.slice(slash + 1);
      if (p) {
        const hits = [...snap.models.values()].filter((m) => m.providerId === p.id && m.upstreamModelId === upstreamId && modelAllowed(gk, snap, m));
        if (hits.length) return { aliasId: null, targets: hits.map((model) => ({ model, weight: 1, priority: 0 })) };
      }
    }
    const bare = [...snap.models.values()].filter((m) => m.upstreamModelId === requested && modelAllowed(gk, snap, m));
    if (bare.length) return { aliasId: null, targets: bare.map((model) => ({ model, weight: 1, priority: snap.providers.get(model.providerId)!.priority })) };
  }

  throw new GatewayError(
    404,
    'invalid_request_error',
    'model_not_allowed',
    existsIgnoringScope(requested, snap)
      ? `"${requested}" exists but this API key's access settings (allowed aliases, models or providers) exclude it`
      : `No model or alias named "${requested}" is enabled on this gateway`,
  );
}

/** Whether the name would resolve for an unrestricted key — tells "not allowed" apart from "not there". */
function existsIgnoringScope(requested: string, snap: ConfigSnapshot): boolean {
  const usable = (m: Model | undefined) => !!m && m.enabled && !!snap.providers.get(m.providerId)?.enabled;
  const alias = snap.aliasesByName.get(requested);
  if (alias?.enabled && alias.targets.some((t) => t.enabled && usable(snap.models.get(t.modelId)))) return true;
  const slash = requested.indexOf('/');
  const p = slash > 0 ? snap.providersByName.get(requested.slice(0, slash).toLowerCase()) : undefined;
  return [...snap.models.values()].some(
    (m) => usable(m) && (m.upstreamModelId === requested || (p && m.providerId === p.id && m.upstreamModelId === requested.slice(slash + 1))),
  );
}
