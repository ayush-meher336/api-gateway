import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/client.js';
import { createServices, type Services } from '../src/services.js';
import { buildApp } from '../src/app.js';
import { startMockUpstream } from './helpers/mockUpstream.js';
import type { NewRequestLog } from '../src/logging/logWriter.js';

let s: Services;
let app: FastifyInstance;
let cookie: string;
let dataDir: string;

async function req(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: method as any, url: `/admin/api/${url}`, payload: payload as any, headers: { cookie, ...headers } });
}

async function login() {
  await app.inject({ method: 'POST', url: '/admin/api/auth/setup', payload: { password: 'supersecret' } });
  const r = await app.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { password: 'supersecret' } });
  cookie = String(r.headers['set-cookie']).split(';')[0];
}

function fakeLog(over: Partial<NewRequestLog>): NewRequestLog {
  return {
    ts: Date.now(), gatewayKeyId: 1, requestedModel: 'm', aliasId: null, providerId: 1, modelId: 1, upstreamKeyId: 1, endpoint: 'chat',
    stream: false, status: 'ok', httpStatus: 200, errorType: null, errorMessage: null, latencyMs: 100, ttftMs: null, attempts: 1,
    inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.001, usageEstimated: false,
    clientIp: null, requestBody: null, responseBody: null, ...over,
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gw-admin-'));
  s = createServices(openDb(join(dataDir, 'gateway.db')), randomBytes(32));
  app = buildApp(s, { dataDir });
  await app.ready();
  cookie = '';
});
afterEach(async () => {
  await app.close();
  s.db.close();
});

describe('admin auth', () => {
  it('reports setup state, then setup → login → protected route', async () => {
    expect((await req('GET', 'auth/status')).json()).toEqual({ setupRequired: true, authenticated: false });
    expect((await req('GET', 'providers')).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/admin/api/auth/setup', payload: { password: 'short' } })).statusCode).toBe(400);
    await login();
    expect((await req('GET', 'auth/status')).json()).toEqual({ setupRequired: false, authenticated: true });
    expect((await req('GET', 'providers')).statusCode).toBe(200);
    // setup cannot be repeated
    expect((await app.inject({ method: 'POST', url: '/admin/api/auth/setup', payload: { password: 'anotherpass' } })).statusCode).toBe(409);
  });

  it('rejects wrong passwords and rate-limits login attempts', async () => {
    await login();
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { password: 'wrongwrong' } })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { password: 'supersecret' } })).statusCode).toBe(429);
  });

  it('logout invalidates the session', async () => {
    await login();
    await req('POST', 'auth/logout');
    expect((await req('GET', 'providers')).statusCode).toBe(401);
  });

  it('change password', async () => {
    await login();
    expect((await req('POST', 'auth/password', { current: 'nope', next: 'brandnewpass' })).statusCode).toBe(401);
    expect((await req('POST', 'auth/password', { current: 'supersecret', next: 'brandnewpass' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { password: 'brandnewpass' } })).statusCode).toBe(200);
  });
});

describe('admin resources', () => {
  beforeEach(login);

  it('validation errors use the standard error shape', async () => {
    const r = await req('POST', 'providers', { name: '', type: 'bogus' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('validation_error');
    expect(r.json().error.message).toContain('type');
  });

  it('provider create fills default base url; 404 for missing ids', async () => {
    const p = (await req('POST', 'providers', { name: 'groq', type: 'groq' })).json();
    expect(p.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect((await req('PATCH', 'providers/999', { enabled: false })).statusCode).toBe(404);
    expect((await req('POST', 'providers', { name: 'groq', type: 'groq' })).statusCode).toBe(409);
    expect((await req('POST', 'providers', { name: 'c', type: 'custom_openai' })).statusCode).toBe(400);
  });

  it('bulk keys: blank lines ignored, duplicates reported, secrets never returned', async () => {
    const p = (await req('POST', 'providers', { name: 'oa', type: 'openai' })).json();
    const r = await req('POST', 'upstream-keys/bulk', { providerId: p.id, secrets: 'sk-one\n\n sk-two \nsk-three\nsk-one', tags: ['p3'], weight: 2 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ created: 3, duplicates: 1 });
    const list = (await req('GET', `upstream-keys?providerId=${p.id}`)).json();
    expect(list).toHaveLength(3);
    expect(JSON.stringify(list)).not.toContain('sk-one');
    expect(list[0]).toMatchObject({ tags: ['p3'], weight: 2, status: 'active' });
    const k = list[0];
    expect((await req('PATCH', `upstream-keys/${k.id}`, { status: 'disabled', tags: ['x'] })).json()).toMatchObject({ status: 'disabled', tags: ['x'] });
    s.repos.upstreamKeys.setStatus(k.id, 'invalid', { lastError: 'bad' });
    expect((await req('POST', `upstream-keys/${k.id}/reset`)).json()).toMatchObject({ status: 'active', lastError: null });
  });

  it('sync-models pulls the provider model list', async () => {
    const up = await startMockUpstream(() => ({ json: { data: [{ id: 'm-a' }, { id: 'm-b' }] } }));
    try {
      const p = (await req('POST', 'providers', { name: 'mock', type: 'custom_openai', baseUrl: up.url })).json();
      expect((await req('POST', `providers/${p.id}/sync-models`)).statusCode).toBe(400); // no keys yet
      await req('POST', 'upstream-keys/bulk', { providerId: p.id, secrets: 'sk-1' });
      const r = await req('POST', `providers/${p.id}/sync-models`);
      expect(r.json()).toEqual({ added: 2, updated: 0 });
      expect((await req('GET', `models?providerId=${p.id}`)).json().map((m: any) => m.upstreamModelId)).toEqual(['m-a', 'm-b']);
      expect((await req('POST', `providers/${p.id}/test`)).json()).toMatchObject({ ok: true, models: 2 });
    } finally {
      await up.close();
    }
  });

  it('aliases with targets and model price edits', async () => {
    const p = (await req('POST', 'providers', { name: 'oa', type: 'openai' })).json();
    const m = (await req('POST', 'models', { providerId: p.id, upstreamModelId: 'gpt-x', priceInputPerM: 1 })).json();
    expect((await req('PATCH', `models/${m.id}`, { priceOutputPerM: 4 })).json()).toMatchObject({ priceInputPerM: 1, priceOutputPerM: 4 });
    const a = (await req('POST', 'aliases', { name: 'fast', targets: [{ modelId: m.id, weight: 3 }] })).json();
    expect(a.targets[0]).toMatchObject({ modelId: m.id, weight: 3 });
    expect((await req('POST', 'aliases', { name: 'bad', targets: [{ modelId: 9999 }] })).statusCode).toBe(400);
  });

  it('gateway key create returns the plain key exactly once', async () => {
    const r = await req('POST', 'gateway-keys', { name: 'app', pool: { mode: 'tags', tags: ['p3'] }, strategy: 'weighted', budgetDailyUsd: 5 });
    expect(r.statusCode).toBe(200);
    const created = r.json();
    expect(created.key).toMatch(/^gw-/);
    expect(created.pool).toEqual({ mode: 'tags', tags: ['p3'] });
    const got = (await req('GET', `gateway-keys/${created.id}`)).json();
    expect(got.key).toBeUndefined();
    expect(JSON.stringify((await req('GET', 'gateway-keys')).json())).not.toContain(created.key);
    const regen = (await req('POST', `gateway-keys/${created.id}/regenerate`)).json();
    expect(regen.key).not.toBe(created.key);
    expect((await req('POST', 'gateway-keys', { name: 'x', strategy: 'nope' })).statusCode).toBe(400);
  });

  it('logs list with filters and cursor pagination, detail with attempts', async () => {
    for (let i = 0; i < 5; i++) s.logWriter.enqueue(fakeLog({ status: i % 2 ? 'error' : 'ok' }), [{ n: 1, providerId: 1, upstreamKeyId: 1, modelId: 1, httpStatus: 200, errorType: null, errorMessage: null, latencyMs: 1 }]);
    s.logWriter.flush();
    const page1 = (await req('GET', 'logs?limit=2')).json();
    expect(page1.items).toHaveLength(2);
    const page2 = (await req('GET', `logs?limit=2&cursor=${page1.nextCursor}`)).json();
    expect(page2.items[0].id).toBeLessThan(page1.items[1].id);
    expect((await req('GET', 'logs?status=error')).json().items).toHaveLength(2);
    const d = (await req('GET', `logs/${page1.items[0].id}`)).json();
    expect(d.attempts).toHaveLength(1);
  });

  it('analytics: summary, timeseries grouped by provider, top, csv', async () => {
    const now = Date.now();
    s.logWriter.enqueue(fakeLog({ providerId: 1, latencyMs: 100 }), []);
    s.logWriter.enqueue(fakeLog({ providerId: 1, latencyMs: 300, cachedReadTokens: 5 }), []);
    s.logWriter.enqueue(fakeLog({ providerId: 2, latencyMs: 200, status: 'error' }), []);
    s.logWriter.flush();
    const q = `from=${now - 3_600_000}&to=${now + 3_600_000}`;
    const sum = (await req('GET', `analytics/summary?${q}`)).json();
    expect(sum).toMatchObject({ requests: 3, errors: 1, inputTokens: 30, outputTokens: 15, cachedReadTokens: 5 });
    expect(sum.p50LatencyMs).toBe(200);
    const ts = (await req('GET', `analytics/timeseries?${q}&metric=requests&groupBy=provider`)).json();
    expect(ts.bucket).toBe('hour');
    const totals = Object.fromEntries(ts.series.map((x: any) => [x.key, x.points.reduce((a: number, p: any) => a + p.v, 0)]));
    expect(totals).toEqual({ '1': 2, '2': 1 });
    const top = (await req('GET', `analytics/top?${q}&dimension=provider&metric=requests&limit=1`)).json();
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ key: '1', value: 2 });
    const csv = await req('GET', `analytics/export.csv?${q}&groupBy=provider`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('bucket_start,group,requests,errors,input_tokens,output_tokens,cached_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,avg_latency_ms');
  });

  it('alerts list invalid keys and cooldowns', async () => {
    const p = (await req('POST', 'providers', { name: 'oa', type: 'openai' })).json();
    await req('POST', 'upstream-keys/bulk', { providerId: p.id, secrets: 'a\nb' });
    const [k1, k2] = s.repos.upstreamKeys.list();
    s.repos.upstreamKeys.setStatus(k1.id, 'invalid', { lastError: 'bad key' });
    s.repos.upstreamKeys.setStatus(k2.id, 'cooldown', { cooldownUntil: Date.now() + 60_000 });
    const kinds = (await req('GET', 'alerts')).json().map((a: any) => a.kind).sort();
    expect(kinds).toEqual(['key_cooldown', 'key_invalid']);
  });

  it('settings get/put', async () => {
    expect((await req('GET', 'settings')).json()).toMatchObject({ retentionDays: 90 });
    expect((await req('PUT', 'settings', { retentionDays: 30 })).json()).toMatchObject({ retentionDays: 30 });
    expect((await req('PUT', 'settings', { retentionDays: -1 })).statusCode).toBe(400);
  });

  it('backup streams a sqlite file', async () => {
    const r = await req('GET', 'settings/backup');
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.subarray(0, 15).toString()).toBe('SQLite format 3');
  });

  it('restore stages an uploaded database for the next start', async () => {
    const backup = (await req('GET', 'settings/backup')).rawPayload;
    const boundary = 'XBOUNDARY';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.db"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      backup,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await app.inject({ method: 'POST', url: '/admin/api/settings/restore', payload: body, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json().restartRequired).toBe(true);
    expect(existsSync(join(dataDir, 'restore-pending.db'))).toBe(true);
  });

  it('config export → import roundtrip keeps gateway keys working', async () => {
    const p = (await req('POST', 'providers', { name: 'oa', type: 'openai' })).json();
    await req('POST', 'upstream-keys/bulk', { providerId: p.id, secrets: 'sk-live-aaaa1111\nsk-live-bbbb2222', tags: ['t'] });
    const m = (await req('POST', 'models', { providerId: p.id, upstreamModelId: 'gpt-x' })).json();
    await req('POST', 'aliases', { name: 'fast', targets: [{ modelId: m.id }] });
    const keys = s.repos.upstreamKeys.list();
    const gk = (await req('POST', 'gateway-keys', { name: 'app', pool: { mode: 'explicit', keyIds: [keys[1].id] }, allowedProviderIds: [p.id] })).json();
    expect(JSON.stringify((await req('GET', 'config/export')).json())).not.toContain('sk-live-aaaa1111');
    const exported = (await req('GET', 'config/export?includeSecrets=1')).json();

    const s2 = createServices(openDb(':memory:'), randomBytes(32));
    const app2 = buildApp(s2, { dataDir });
    await app2.ready();
    await app2.inject({ method: 'POST', url: '/admin/api/auth/setup', payload: { password: 'supersecret' } });
    const c2 = String((await app2.inject({ method: 'POST', url: '/admin/api/auth/login', payload: { password: 'supersecret' } })).headers['set-cookie']).split(';')[0];
    const imp = await app2.inject({ method: 'POST', url: '/admin/api/config/import', payload: exported, headers: { cookie: c2 } });
    expect(imp.statusCode).toBe(200);
    expect(s2.repos.upstreamKeys.list()).toHaveLength(2);
    expect(s2.repos.aliases.list()[0].targets).toHaveLength(1);
    const g2 = s2.repos.gatewayKeys.list()[0];
    expect(g2.name).toBe('app');
    const k2 = s2.repos.upstreamKeys.list().find((k) => s2.repos.upstreamKeys.getSecret(k.id) === 'sk-live-bbbb2222')!;
    expect(g2.pool).toEqual({ mode: 'explicit', keyIds: [k2.id] });
    expect(g2.allowedProviderIds).toEqual([s2.repos.providers.list()[0].id]);
    const auth = await app2.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${gk.key}` } });
    expect(auth.statusCode).toBe(200);
    // importing twice is idempotent
    await app2.inject({ method: 'POST', url: '/admin/api/config/import', payload: exported, headers: { cookie: c2 } });
    expect(s2.repos.upstreamKeys.list()).toHaveLength(2);
    expect(s2.repos.gatewayKeys.list()).toHaveLength(1);
    await app2.close();
  });
});
