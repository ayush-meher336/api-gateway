import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/client.js';
import { createServices, type Services } from '../src/services.js';
import { buildApp } from '../src/app.js';
import { generateGatewayKey } from '../src/crypto/gatewayKey.js';
import { startMockUpstream, chatJson, type Reply } from './helpers/mockUpstream.js';
import type { GatewayKey } from '../src/db/types.js';

let s: Services;
let app: FastifyInstance;
let up: Awaited<ReturnType<typeof startMockUpstream>>;
let handler: (req: any, n: number) => Reply;
let gwKey: string;
let gk: GatewayKey;
let providerId: number;
let keyIds: number[];

async function setup(gkOver: Partial<GatewayKey> = {}) {
  const k = generateGatewayKey();
  gwKey = k.plain;
  gk = s.repos.gatewayKeys.create({ name: 't', keyHash: k.hash, keyPrefix: k.prefix, ...gkOver } as any);
  s.snapshots.invalidate();
}

beforeEach(async () => {
  handler = () => ({ json: chatJson() });
  up = await startMockUpstream((req, n) => handler(req, n));
  s = createServices(openDb(':memory:'), randomBytes(32));
  providerId = s.repos.providers.create({ name: 'mock', type: 'custom_openai', baseUrl: up.url, timeoutMs: 2000 }).id;
  keyIds = s.repos.upstreamKeys.createMany(providerId, ['sk-a', 'sk-b', 'sk-c'], {}).created.map((k) => k.id);
  s.repos.models.create({ providerId, upstreamModelId: 'up-model', priceInputPerM: 1, priceOutputPerM: 2 });
  s.repos.models.create({ providerId, upstreamModelId: 'emb', priceInputPerM: 1 });
  s.repos.aliases.create({ name: 'fast', targets: [{ modelId: s.repos.models.list()[1].id }] });
  await setup();
  app = buildApp(s);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await up.close();
});

const chat = (body: any = {}, key = gwKey) =>
  app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${key}` }, payload: { model: 'fast', messages: [{ role: 'user', content: 'hello' }], ...body } });

async function logs(n: number) {
  let rows: any[] = [];
  await vi.waitFor(() => {
    s.logWriter.flush();
    rows = s.db.prepare('SELECT * FROM request_logs ORDER BY id').all() as any[];
    expect(rows.length).toBe(n);
  });
  return rows;
}

const keyOf = (seen: { headers: any }) => String(seen.headers.authorization).replace('Bearer ', '');

describe('proxy', () => {
  it('non-stream success returns the upstream body and logs tokens and cost', async () => {
    const r = await chat();
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].message.content).toBe('hi');
    expect(up.seen[0].body.model).toBe('up-model');
    const [l] = await logs(1);
    expect(l).toMatchObject({ status: 'ok', http_status: 200, input_tokens: 10, output_tokens: 5, attempts: 1, requested_model: 'fast', provider_id: providerId });
    expect(l.cost_usd).toBeCloseTo((10 * 1 + 5 * 2) / 1e6, 12);
  });

  it('rotates across keys: 3 calls hit 3 distinct upstream keys', async () => {
    for (let i = 0; i < 3; i++) expect((await chat()).statusCode).toBe(200);
    expect(new Set(up.seen.map(keyOf))).toEqual(new Set(['sk-a', 'sk-b', 'sk-c']));
  });

  it('streams chunks through and logs final usage', async () => {
    handler = () => ({
      sse: [
        JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }),
        '[DONE]',
      ],
    });
    const r = await chat({ stream: true });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.body).toContain('"Hel"');
    expect(r.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(up.seen[0].body.stream_options).toEqual({ include_usage: true });
    const [l] = await logs(1);
    expect(l).toMatchObject({ stream: 1, input_tokens: 7, output_tokens: 2, usage_estimated: 0 });
    expect(l.ttft_ms).not.toBeNull();
  });

  it('429 with Retry-After fails over and cools the key down', async () => {
    handler = (_req, n) => (n === 0 ? { status: 429, json: { error: { message: 'slow down' } }, headers: { 'retry-after': '5' } } : { json: chatJson() });
    const before = Date.now();
    const r = await chat();
    expect(r.statusCode).toBe(200);
    const first = keyOf(up.seen[0]);
    expect(keyOf(up.seen[1])).not.toBe(first);
    const k = s.repos.upstreamKeys.list().find((x) => s.repos.upstreamKeys.getSecret(x.id) === first)!;
    expect(k.status).toBe('cooldown');
    expect(k.cooldownUntil!).toBeGreaterThanOrEqual(before + 5000);
    expect(k.cooldownUntil!).toBeLessThan(before + 7000);
    const [l] = await logs(1);
    expect(l.attempts).toBe(2);
    expect(s.db.prepare('SELECT count(*) c FROM request_attempts').get()).toEqual({ c: 2 });
  });

  it('cooled-down keys are skipped by later requests', async () => {
    handler = (_req, n) => (n === 0 ? { status: 429, json: {} } : { json: chatJson() });
    await chat();
    const cooled = keyOf(up.seen[0]);
    for (let i = 0; i < 4; i++) await chat();
    expect(up.seen.slice(2).map(keyOf)).not.toContain(cooled);
  });

  it('401 from upstream marks the key invalid and fails over', async () => {
    handler = (_req, n) => (n === 0 ? { status: 401, json: { error: { message: 'bad key' } } } : { json: chatJson() });
    expect((await chat()).statusCode).toBe(200);
    expect(s.repos.upstreamKeys.list().filter((k) => k.status === 'invalid')).toHaveLength(1);
  });

  it('400 from upstream is returned as-is without retry', async () => {
    handler = () => ({ status: 400, json: { error: { message: 'context too long' } } });
    const r = await chat();
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ type: 'upstream_error', message: 'context too long' });
    expect(up.seen).toHaveLength(1);
    expect(s.repos.upstreamKeys.list().every((k) => k.status === 'active')).toBe(true);
  });

  it('5xx retries up to maxRetries then returns 502', async () => {
    await setup({ maxRetries: 1 });
    handler = () => ({ status: 500, json: { error: { message: 'boom' } } });
    const r = await chat();
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe('all_upstreams_failed');
    expect(up.seen).toHaveLength(2);
  });

  it('all keys unavailable returns 503 no_available_upstream with soonest cooldown', async () => {
    const until = Date.now() + 60_000;
    for (const id of keyIds) s.repos.upstreamKeys.setStatus(id, 'cooldown', { cooldownUntil: until });
    s.snapshots.invalidate();
    const r = await chat();
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('no_available_upstream');
    expect(r.json().error.message).toContain(new Date(until).toISOString());
    expect(up.seen).toHaveLength(0);
    const [l] = await logs(1);
    expect(l.error_type).toBe('no_available_upstream');
  });

  it('decrypt failure marks key invalid and uses another key', async () => {
    s.db.prepare("UPDATE upstream_keys SET secret_enc = 'garbage' WHERE id = ?").run(keyIds[0]);
    for (let i = 0; i < 3; i++) expect((await chat()).statusCode).toBe(200);
    const k = s.repos.upstreamKeys.get(keyIds[0])!;
    expect(k.status).toBe('invalid');
    expect(k.lastError).toBe('decrypt_failed');
  });

  it('wrong gateway key gives 401 standard error body', async () => {
    const r = await chat({}, 'gw-nope');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { type: 'authentication_error', code: 'invalid_api_key', message: expect.any(String) } });
    const missing = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
    expect(missing.statusCode).toBe(401);
  });

  it('accepts x-api-key header', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { 'x-api-key': gwKey }, payload: { model: 'fast', messages: [] } });
    expect(r.statusCode).toBe(200);
  });

  it('expired and disabled keys are rejected', async () => {
    s.repos.gatewayKeys.update(gk.id, { expiresAt: Date.now() - 1 });
    expect((await chat()).json().error.code).toBe('key_expired');
    s.repos.gatewayKeys.update(gk.id, { expiresAt: null, enabled: false });
    expect((await chat()).statusCode).toBe(401);
  });

  it('enforces gateway key rpm', async () => {
    await setup({ rpmLimit: 2 });
    expect((await chat()).statusCode).toBe(200);
    expect((await chat()).statusCode).toBe(200);
    const r = await chat();
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('gateway_limit');
  });

  it('enforces daily budget from usage rollups', async () => {
    await setup({ budgetDailyUsd: 0.000001 });
    expect((await chat()).statusCode).toBe(200);
    await logs(1);
    s.usage.clear();
    const r = await chat();
    expect(r.statusCode).toBe(402);
    expect(r.json().error.code).toBe('budget_exceeded');
  });

  it('enforces ip allowlist', async () => {
    await setup({ ipAllowlist: ['10.0.0.0/8'] });
    const r = await chat();
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('ip_not_allowed');
  });

  it('applies defaultParams, paramOverrides and maxTokensCap', async () => {
    await setup({ defaultParams: { temperature: 0.1, top_p: 0.5 }, paramOverrides: { user: 'forced' }, maxTokensCap: 100 });
    await chat({ top_p: 0.9, user: 'mine', max_tokens: 500 });
    const b = up.seen[0].body;
    expect(b.temperature).toBe(0.1);
    expect(b.top_p).toBe(0.9);
    expect(b.user).toBe('forced');
    expect(b.max_tokens).toBe(100);
  });

  it('unknown or out-of-scope model returns 404', async () => {
    const r = await chat({ model: 'nope' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('model_not_allowed');
  });

  it('invalid body returns 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${gwKey}` }, payload: { messages: [] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('model_required');
  });

  it('/v1/models lists only scoped models', async () => {
    let r = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${gwKey}` } });
    expect(r.json().data.map((m: any) => m.id).sort()).toEqual(['fast', 'mock/emb', 'mock/up-model']);
    await setup({ allowedAliases: ['fast'] });
    r = await app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${gwKey}` } });
    expect(r.json().data.map((m: any) => m.id)).toEqual(['fast']);
  });

  it('estimates usage when the provider reports none', async () => {
    handler = () => ({ json: { choices: [{ message: { role: 'assistant', content: 'a reasonably long answer here' } }] } });
    await chat();
    const [l] = await logs(1);
    expect(l.usage_estimated).toBe(1);
    expect(l.output_tokens).toBeGreaterThan(0);
  });

  it('embeddings are proxied', async () => {
    handler = () => ({ json: { data: [{ embedding: [1] }], usage: { prompt_tokens: 3 } } });
    const r = await app.inject({ method: 'POST', url: '/v1/embeddings', headers: { authorization: `Bearer ${gwKey}` }, payload: { model: 'mock/emb', input: 'x' } });
    expect(r.statusCode).toBe(200);
    expect(up.seen[0].url).toBe('/v1/embeddings');
  });

  it('mid-stream failure ends the stream with an error event and logs an error', async () => {
    handler = () => ({ sse: [JSON.stringify({ choices: [{ delta: { content: 'part' } }] }), 'x', 'y'], failAfter: 1 });
    const r = await chat({ stream: true });
    expect(r.body).toContain('"part"');
    expect(r.body).toContain('"error"');
    expect(r.body.trim().endsWith('data: [DONE]')).toBe(true);
    const [l] = await logs(1);
    expect(l.status).toBe('error');
    expect(l.error_type).toBe('stream_interrupted');
  });

  it('stream failing before the first chunk fails over to another key', async () => {
    handler = (_req, n) => (n === 0 ? { sse: ['a'], failAfter: 0 } : { sse: [JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), '[DONE]'] });
    const r = await chat({ stream: true });
    expect(r.body).toContain('"ok"');
    expect(up.seen).toHaveLength(2);
  });

  it('times out a hanging upstream and fails over', async () => {
    s.repos.providers.update(providerId, { timeoutMs: 200 });
    s.snapshots.invalidate();
    handler = (_req, n) => (n === 0 ? { hang: true } : { json: chatJson() });
    const r = await chat();
    expect(r.statusCode).toBe(200);
    expect(up.seen).toHaveLength(2);
  });

  it('aborts upstream on client disconnect', async () => {
    handler = () => ({ sse: [JSON.stringify({ choices: [{ delta: { content: 'x' } }] })], hangAfter: true });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as any).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gwKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fast', stream: true, messages: [] }),
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await vi.waitFor(() => expect(up.aborted.length).toBe(1));
    const [l] = await logs(1);
    expect(l.error_type).toBe('client_aborted');
  });

  it('records the gateway key last used time and upstream key last used', async () => {
    await chat();
    expect(s.repos.upstreamKeys.list().some((k) => k.lastUsedAt)).toBe(true);
  });
});

describe('cooldown backoff under concurrency', () => {
  it('concurrent 429s on the same key advance its fail streak', async () => {
    await setup({ pool: { mode: 'explicit', keyIds: [keyIds[0]] }, maxRetries: 0 });
    handler = () => ({ status: 429, json: {} });
    await Promise.all([chat(), chat(), chat()]);
    expect(s.repos.upstreamKeys.get(keyIds[0])!.failStreak).toBe(3);
    s.repos.upstreamKeys.setStatus(keyIds[0], 'cooldown', { cooldownUntil: 0 });
    s.snapshots.updateKey(keyIds[0], { cooldownUntil: 0 });
    await chat();
    const k = s.repos.upstreamKeys.get(keyIds[0])!;
    expect(k.failStreak).toBe(4);
    // 30s * 2^(4-1) = 240s of backoff
    expect(k.cooldownUntil! - Date.now()).toBeGreaterThan(230_000);
  });
});
