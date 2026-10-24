import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/client.js';
import { createServices } from '../src/services.js';
import { buildApp } from '../src/app.js';
import { applyPendingRestore } from '../src/bootstrap.js';

let app: FastifyInstance;
let webDir: string;

beforeEach(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'gw-web-'));
  writeFileSync(join(webDir, 'index.html'), '<html>dashboard</html>');
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  app = buildApp(createServices(openDb(':memory:'), randomBytes(32)), { webDir });
  app.get('/boom', async () => {
    throw new Error('secret internal detail');
  });
  await app.ready();
});
afterEach(() => app.close());

describe('app', () => {
  it('/health reports ok', async () => {
    const r = await app.inject('/health');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: 'ok', db: true });
    expect(typeof r.json().uptimeS).toBe('number');
  });

  it('a throwing route gives a generic 500 and the server keeps serving', async () => {
    const r = await app.inject('/boom');
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: { type: 'internal_error', code: 'internal_error', message: 'The gateway hit an unexpected error' } });
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('unknown API paths get a standard 404 body', async () => {
    for (const url of ['/v1/foo', '/admin/api/nope']) {
      const r = await app.inject(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error).toBeDefined();
    }
  });

  it('serves the dashboard with SPA fallback', async () => {
    expect((await app.inject('/')).body).toContain('dashboard');
    expect((await app.inject('/gateway-keys/5')).body).toContain('dashboard');
    expect((await app.inject('/assets/app.js')).body).toBe('console.log(1)');
  });

  it('serves assets added after startup (dashboard rebuilt while running)', async () => {
    writeFileSync(join(webDir, 'assets', 'new-hash.js'), 'console.log(2)');
    const r = await app.inject('/assets/new-hash.js');
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('console.log(2)');
  });

  it('a missing asset is a 404, never the HTML shell', async () => {
    const r = await app.inject('/assets/gone.js');
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('dashboard');
  });

  it('malformed JSON gives a 400 standard body', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.type).toBe('invalid_request_error');
  });
});

describe('applyPendingRestore', () => {
  it('swaps a staged backup in and keeps the previous db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-restore-'));
    const live = join(dir, 'gateway.db');
    const a = openDb(live);
    a.prepare("INSERT INTO settings(key, value) VALUES('which', '\"old\"')").run();
    a.close();
    const staged = openDb(join(dir, 'restore-pending.db'));
    staged.prepare("INSERT INTO settings(key, value) VALUES('which', '\"new\"')").run();
    staged.close();
    expect(applyPendingRestore(dir, live)).toBe(true);
    const db = openDb(live);
    expect(db.prepare("SELECT value FROM settings WHERE key='which'").get()).toEqual({ value: '"new"' });
    db.close();
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false);
    expect(applyPendingRestore(dir, live)).toBe(false);
  });
});
