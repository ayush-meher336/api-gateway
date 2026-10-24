import type { Db } from '../client.js';

export function settingsRepo(db: Db) {
  return {
    get<T>(key: string, fallback: T): T {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : fallback;
    },
    set(key: string, value: unknown): void {
      db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        JSON.stringify(value),
      );
    },
    all(): Record<string, unknown> {
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    },
  };
}
