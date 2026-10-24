import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startMockUpstream, chatJson } from './helpers/mockUpstream.js';

/**
 * Full stack: a real gateway process (src/index.ts via tsx) talking to a mock provider over HTTP,
 * driven only through the public admin and /v1 APIs — the same path the dashboard and apps use.
 */
let proc: ChildProcess;
let up: Awaited<ReturnType<typeof startMockUpstream>>;
let base: string;
let cookie = '';
let output = '';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  up = await startMockUpstream((req) =>
    req.url.endsWith('/models') ? { json: { data: [{ id: 'mock-model' }] } } : { json: chatJson('hello from mock') },
  );
  const dir = mkdtempSync(join(tmpdir(), 'gw-e2e-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  const root = resolve(__dirname, '..');
  proc = spawn(process.execPath, ['--import', 'tsx', join(root, 'src', 'index.ts')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(dir, 'data'), GATEWAY_ENV_FILE: join(dir, '.env'), GATEWAY_MASTER_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (output += d));
  proc.stderr!.on('data', (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/health')).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('gateway did not start:\n' + output);
}, 30_000);

afterAll(async () => {
  proc?.kill();
  await up?.close();
});

describe('end to end', () => {
  it('setup → provider → keys → sync → gateway key → rotated calls → logs', async () => {
    expect((await call('POST', '/admin/api/auth/setup', { password: 'e2e-test-pass' })).status).toBe(200);
    const p = await call('POST', '/admin/api/providers', { name: 'mock', type: 'custom_openai', baseUrl: up.url });
    expect(p.status).toBe(200);
    expect((await call('POST', '/admin/api/upstream-keys/bulk', { providerId: p.json.id, secrets: 'sk-e2e-key-one\nsk-e2e-key-two' })).json.created).toBe(2);
    expect((await call('POST', `/admin/api/providers/${p.json.id}/sync-models`)).json).toEqual({ added: 1, updated: 0 });
    const gk = await call('POST', '/admin/api/gateway-keys', { name: 'e2e' });
    expect(gk.json.key).toMatch(/^gw-/);

    const auth = { authorization: `Bearer ${gk.json.key}` };
    const models = await call('GET', '/v1/models', undefined, auth);
    expect(models.json.data.map((m: any) => m.id)).toEqual(['mock/mock-model']);
    for (let i = 0; i < 2; i++) {
      const r = await call('POST', '/v1/chat/completions', { model: 'mock/mock-model', messages: [{ role: 'user', content: 'hi' }] }, auth);
      expect(r.status).toBe(200);
      expect(r.json.choices[0].message.content).toBe('hello from mock');
    }
    expect(new Set(up.seen.filter((x) => x.url.endsWith('/chat/completions')).map((x) => x.headers.authorization))).toEqual(
      new Set(['Bearer sk-e2e-key-one', 'Bearer sk-e2e-key-two']),
    );

    let logs: any;
    for (let i = 0; i < 20; i++) {
      logs = await call('GET', '/admin/api/logs');
      if (logs.json.items.length === 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(logs.json.items).toHaveLength(2);
    expect(new Set(logs.json.items.map((l: any) => l.upstreamKeyId)).size).toBe(2);
    const summary = await call('GET', '/admin/api/analytics/summary');
    expect(summary.json).toMatchObject({ requests: 2, inputTokens: 20, outputTokens: 10 });
  }, 30_000);
});
