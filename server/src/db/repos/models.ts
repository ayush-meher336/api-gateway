import { tx, type Db } from '../client.js';
import type { Capabilities, Model } from '../types.js';
import { table } from './table.js';

export interface ModelInfo {
  upstreamModelId: string;
  displayName?: string;
  contextLength?: number;
  capabilities?: Capabilities;
}

export type ModelInput = Pick<Model, 'providerId' | 'upstreamModelId'> & Partial<Omit<Model, 'id'>>;

export function modelsRepo(db: Db) {
  const t = table<Model>(db, 'models', { capabilities: 'json', enabled: 'bool' });
  return {
    list: (providerId?: number) =>
      providerId ? t.list('WHERE provider_id = ? ORDER BY upstream_model_id', providerId) : t.list('ORDER BY provider_id, upstream_model_id'),
    get: t.get,
    create(input: ModelInput): Model {
      return t.get(t.insert({ source: 'manual', ...input }))!;
    },
    update(id: number, patch: Partial<ModelInput>): Model {
      t.update(id, patch);
      return t.get(id)!;
    },
    delete: t.delete,
    /** Adds new models, refreshes metadata on existing ones; never touches prices or enabled. */
    upsertSynced(providerId: number, infos: ModelInfo[]) {
      let added = 0;
      let updated = 0;
      const find = db.prepare('SELECT id FROM models WHERE provider_id = ? AND upstream_model_id = ?');
      tx(db, () => {
        for (const m of infos) {
          const row = find.get(providerId, m.upstreamModelId) as { id: number } | undefined;
          const meta: Partial<Model> = { source: 'synced' };
          if (m.displayName !== undefined) meta.displayName = m.displayName;
          if (m.contextLength !== undefined) meta.contextLength = m.contextLength;
          if (m.capabilities !== undefined) meta.capabilities = m.capabilities;
          if (row) {
            t.update(row.id, meta);
            updated++;
          } else {
            t.insert({ providerId, upstreamModelId: m.upstreamModelId, capabilities: m.capabilities ?? {}, ...meta });
            added++;
          }
        }
      });
      return { added, updated };
    },
  };
}
