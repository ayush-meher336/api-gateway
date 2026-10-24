import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/client.js';
import { loadEnv } from '../src/config/env.js';

describe('db', () => {
  it('migrates, enforces foreign keys and cascades', () => {
    const db = openDb(':memory:');
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    const p = db.prepare("INSERT INTO providers(name,type,base_url,created_at) VALUES('p','openai','u',1)").run();
    db.prepare("INSERT INTO upstream_keys(provider_id,label,secret_enc,created_at) VALUES(?, 'k','x',1)").run(p.lastInsertRowid);
    expect(db.prepare('SELECT count(*) c FROM upstream_keys').get()).toEqual({ c: 1 });
    db.prepare('DELETE FROM providers').run();
    expect(db.prepare('SELECT count(*) c FROM upstream_keys').get()).toEqual({ c: 0 });
  });

  it('reopening a file db does not re-run migrations', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gw-')), 'g.db');
    openDb(file).close();
    const db = openDb(file);
    expect(db.prepare('SELECT count(*) c FROM schema_migrations').get()).toEqual({ c: 1 });
    db.close();
  });
});

describe('env', () => {
  it('generates and persists a master key on first run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-'));
    delete process.env.GATEWAY_MASTER_KEY;
    const a = loadEnv(join(dir, '.env'));
    expect(a.masterKey.length).toBe(32);
    delete process.env.GATEWAY_MASTER_KEY;
    const b = loadEnv(join(dir, '.env'));
    expect(b.masterKey.equals(a.masterKey)).toBe(true);
    expect(b.port).toBe(8787);
  });
});
