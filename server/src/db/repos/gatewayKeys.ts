import type { Db } from '../client.js';
import type { GatewayKey } from '../types.js';
import { table } from './table.js';

export type GatewayKeyInput = Partial<Omit<GatewayKey, 'id' | 'createdAt' | 'keyPrefix'>> & { name: string };

export function gatewayKeysRepo(db: Db) {
  const t = table<GatewayKey & { keyHash: string }>(db, 'gateway_keys', {
    enabled: 'bool',
    logBodies: 'bool',
    allowedAliases: 'json',
    allowedModelIds: 'json',
    allowedProviderIds: 'json',
    pool: 'json',
    ipAllowlist: 'json',
    defaultParams: 'json',
    paramOverrides: 'json',
  });
  const clean = (k: (GatewayKey & { keyHash?: string }) | null): GatewayKey | null => {
    if (!k) return null;
    const { keyHash: _h, ...rest } = k;
    return rest;
  };
  return {
    list: () => t.list('ORDER BY id').map((k) => clean(k)!),
    get: (id: number) => clean(t.get(id)),
    findByHash(hash: string): GatewayKey | null {
      return clean(t.fromRow(db.prepare('SELECT * FROM gateway_keys WHERE key_hash = ?').get(hash) as any));
    },
    create(input: GatewayKeyInput & { keyHash: string; keyPrefix: string }): GatewayKey {
      return clean(t.get(t.insert({ ...input, createdAt: Date.now() })))!;
    },
    update(id: number, patch: Partial<GatewayKeyInput> & { keyHash?: string; keyPrefix?: string }): GatewayKey {
      t.update(id, patch);
      return clean(t.get(id))!;
    },
    touch(id: number, ts: number) {
      db.prepare('UPDATE gateway_keys SET last_used_at = ? WHERE id = ?').run(ts, id);
    },
    delete: t.delete,
  };
}
