import { createHash } from 'node:crypto';
import { tx, type Db } from '../client.js';
import type { KeyStatus, UpstreamKey } from '../types.js';
import { encrypt, decrypt } from '../../crypto/secretBox.js';
import { table } from './table.js';

export type UpstreamKeyDefaults = Partial<
  Pick<UpstreamKey, 'tags' | 'weight' | 'rpmLimit' | 'tpmLimit' | 'dailyRequestCap' | 'dailyTokenCap' | 'label'>
>;
export type UpstreamKeyPatch = Partial<Omit<UpstreamKey, 'id' | 'createdAt' | 'secretPreview' | 'providerId'>>;

const secretHash = (providerId: number, s: string) => createHash('sha256').update(`${providerId}:${s}`).digest('hex');

export function upstreamKeysRepo(db: Db, masterKey: Buffer) {
  const t = table<UpstreamKey & { secretEnc: string; secretHash: string }>(db, 'upstream_keys', { tags: 'json' });
  // Strip secret columns from everything this repo returns.
  const clean = (k: (UpstreamKey & { secretEnc?: string; secretHash?: string }) | null): UpstreamKey | null => {
    if (!k) return null;
    const { secretEnc: _e, secretHash: _h, ...rest } = k;
    return rest;
  };

  return {
    list: (providerId?: number): UpstreamKey[] =>
      (providerId ? t.list('WHERE provider_id = ? ORDER BY id', providerId) : t.list('ORDER BY id')).map((k) => clean(k)!),
    get: (id: number) => clean(t.get(id)),
    getSecret(id: number): string {
      const row = db.prepare('SELECT secret_enc FROM upstream_keys WHERE id = ?').get(id) as { secret_enc: string } | undefined;
      if (!row) throw new Error(`upstream key ${id} not found`);
      return decrypt(row.secret_enc, masterKey);
    },
    findIdBySecret(providerId: number, secret: string): number | null {
      const row = db.prepare('SELECT id FROM upstream_keys WHERE secret_hash = ?').get(secretHash(providerId, secret.trim())) as { id: number } | undefined;
      return row?.id ?? null;
    },
    /** Inserts trimmed, non-empty, not-yet-present secrets. */
    createMany(providerId: number, secrets: string[], defaults: UpstreamKeyDefaults) {
      const created: UpstreamKey[] = [];
      let duplicates = 0;
      const exists = db.prepare('SELECT 1 FROM upstream_keys WHERE secret_hash = ?');
      tx(db, () => {
        for (const raw of secrets) {
          const s = raw.trim();
          if (!s) continue;
          const h = secretHash(providerId, s);
          if (exists.get(h)) {
            duplicates++;
            continue;
          }
          const id = t.insert({
            providerId,
            label: defaults.label ? (secrets.length > 1 ? `${defaults.label} ${created.length + 1}` : defaults.label) : `key-…${s.slice(-4)}`,
            secretEnc: encrypt(s, masterKey),
            secretHash: h,
            secretPreview: s.slice(-4),
            tags: defaults.tags ?? [],
            weight: defaults.weight ?? 1,
            rpmLimit: defaults.rpmLimit ?? null,
            tpmLimit: defaults.tpmLimit ?? null,
            dailyRequestCap: defaults.dailyRequestCap ?? null,
            dailyTokenCap: defaults.dailyTokenCap ?? null,
            createdAt: Date.now(),
          });
          created.push(clean(t.get(id))!);
        }
      });
      return { created, duplicates };
    },
    update(id: number, patch: UpstreamKeyPatch): UpstreamKey {
      t.update(id, patch);
      return clean(t.get(id))!;
    },
    setStatus(id: number, status: KeyStatus, extra: { cooldownUntil?: number | null; lastError?: string | null; failStreak?: number } = {}) {
      t.update(id, { status, ...extra });
    },
    touch(id: number, ts: number) {
      db.prepare('UPDATE upstream_keys SET last_used_at = ?, fail_streak = 0 WHERE id = ?').run(ts, id);
    },
    delete: t.delete,
  };
}
