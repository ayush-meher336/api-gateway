import type { Db } from '../client.js';

type ColKind = 'json' | 'bool' | 'plain';

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/**
 * Small typed mapper over one table: camelCase fields <-> snake_case columns,
 * JSON and boolean columns converted transparently.
 */
export function table<T extends { id: number }>(db: Db, name: string, kinds: Partial<Record<keyof T, ColKind>>) {
  const toRow = (obj: Partial<T>) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || k === 'id') continue;
      const kind = kinds[k as keyof T];
      out[snake(k)] = kind === 'json' ? (v === null ? null : JSON.stringify(v)) : kind === 'bool' ? (v ? 1 : 0) : v;
    }
    return out;
  };
  const fromRow = (row: Record<string, any> | undefined): T | null => {
    if (!row) return null;
    const out: Record<string, any> = {};
    for (const [col, v] of Object.entries(row)) {
      const k = col.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const kind = kinds[k as keyof T];
      out[k] = kind === 'json' ? (v == null ? null : JSON.parse(v)) : kind === 'bool' ? !!v : v;
    }
    return out as T;
  };

  return {
    fromRow,
    get(id: number): T | null {
      return fromRow(db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id) as any);
    },
    list(where = '', ...params: any[]): T[] {
      return (db.prepare(`SELECT * FROM ${name} ${where}`).all(...params) as any[]).map((r) => fromRow(r)!);
    },
    insert(obj: Partial<T> & Record<string, any>): number {
      const row = toRow(obj);
      const cols = Object.keys(row);
      const sql = cols.length
        ? `INSERT INTO ${name}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`
        : `INSERT INTO ${name} DEFAULT VALUES`;
      return Number(db.prepare(sql).run(...Object.values(row)).lastInsertRowid);
    },
    update(id: number, patch: Partial<T>): void {
      const row = toRow(patch);
      const cols = Object.keys(row);
      if (!cols.length) return;
      db.prepare(`UPDATE ${name} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(row), id);
    },
    delete(id: number): boolean {
      return Number(db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id).changes) > 0;
    },
  };
}
