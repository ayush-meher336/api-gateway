/**
 * Fills a gateway database with demo config and ~2k fake requests over the last 7 days.
 * Usage: npx tsx scripts/seed-demo.ts   (uses DATA_DIR / GATEWAY_ENV_FILE like the server)
 * Never run against your real database: the keys it adds are fake.
 */
import { join, resolve } from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { openDb } from '../src/db/client.js';
import { createServices } from '../src/services.js';
import { generateGatewayKey } from '../src/crypto/gatewayKey.js';
import { computeCost } from '../src/logging/usage.js';

const env = loadEnv(process.env.GATEWAY_ENV_FILE ?? resolve('.env'));
const s = createServices(openDb(join(env.dataDir, 'gateway.db')), env.masterKey);
const r = s.repos;
if (r.providers.list().length) {
  console.error('Database already has providers; refusing to seed.');
  process.exit(1);
}

const mk = (name: string, type: any, keys: number, tags: string[], models: [string, number, number, number?][]) => {
  const p = r.providers.create({ name, type, baseUrl: `https://demo.invalid/${name}/v1` });
  const ks = r.upstreamKeys.createMany(p.id, Array.from({ length: keys }, (_, i) => `sk-demo-${name}-${i}-${Math.random().toString(36).slice(2, 10)}`), { tags }).created;
  const ms = models.map(([id, pin, pout, pc]) => r.models.create({ providerId: p.id, upstreamModelId: id, priceInputPerM: pin, priceOutputPerM: pout, priceCachedReadPerM: pc ?? null, source: 'synced' }));
  return { p, ks, ms };
};

const openai = mk('openai', 'openai', 4, ['paid'], [['gpt-4o', 2.5, 10, 1.25], ['gpt-4o-mini', 0.15, 0.6, 0.075], ['text-embedding-3-small', 0.02, 0]]);
const openrouter = mk('openrouter', 'openrouter', 6, ['free', 'p3'], [['openai/gpt-4o', 2.5, 10], ['meta-llama/llama-3.3-70b-instruct', 0.12, 0.3]]);
const anthropic = mk('anthropic', 'anthropic', 3, ['paid'], [['claude-sonnet-4-5', 3, 15, 0.3], ['claude-haiku-4-5', 1, 5, 0.1]]);
const groq = mk('groq', 'groq', 5, ['free'], [['llama-3.3-70b-versatile', 0.59, 0.79]]);

r.aliases.create({ name: 'gpt-4o', targets: [{ modelId: openai.ms[0].id }, { modelId: openrouter.ms[0].id }] });
r.aliases.create({ name: 'fast', description: 'Cheap and quick', targets: [{ modelId: groq.ms[0].id }, { modelId: openrouter.ms[1].id, weight: 2 }, { modelId: openai.ms[1].id, priority: 1 }] });
r.aliases.create({ name: 'claude', targets: [{ modelId: anthropic.ms[0].id }] });

const gks = ['chat-app', 'batch-jobs', 'personal-scripts'].map((name, i) => {
  const k = generateGatewayKey();
  return r.gatewayKeys.create({
    name,
    keyHash: k.hash,
    keyPrefix: k.prefix,
    pool: i === 1 ? { mode: 'tags', tags: ['free'] } : { mode: 'all' },
    strategy: i === 2 ? 'weighted' : 'round_robin',
    budgetDailyUsd: i === 0 ? 5 : null,
  });
});

const all = [openai, openrouter, anthropic, groq];
const now = Date.now();
const rnd = (a: number, b: number) => Math.floor(a + Math.random() * (b - a));
for (let i = 0; i < 2000; i++) {
  const g = all[rnd(0, all.length)];
  const m = g.ms[rnd(0, g.ms.length)];
  const k = g.ks[i % g.ks.length];
  const err = Math.random() < 0.04;
  const input = rnd(50, 6000);
  const cached = Math.random() < 0.3 ? Math.floor(input * Math.random() * 0.8) : 0;
  const u = { input, output: err ? 0 : rnd(20, 1500), cachedRead: cached, cacheWrite: 0, reasoning: 0, estimated: false };
  s.logWriter.enqueue(
    {
      ts: now - Math.floor(Math.pow(Math.random(), 1.6) * 7 * 86_400_000),
      gatewayKeyId: gks[rnd(0, gks.length)].id, requestedModel: m.upstreamModelId, aliasId: null, providerId: g.p.id, modelId: m.id, upstreamKeyId: k.id,
      endpoint: 'chat', stream: Math.random() < 0.5, status: err ? 'error' : 'ok', httpStatus: err ? 502 : 200,
      errorType: err ? 'all_upstreams_failed' : null, errorMessage: err ? 'All upstream attempts failed. Last error: HTTP 503' : null,
      latencyMs: rnd(250, 4000), ttftMs: rnd(150, 900), attempts: err ? 3 : Math.random() < 0.05 ? 2 : 1,
      inputTokens: u.input, outputTokens: u.output, cachedReadTokens: u.cachedRead, cacheWriteTokens: 0, reasoningTokens: 0,
      costUsd: err ? 0 : computeCost(u, m), usageEstimated: false, clientIp: '127.0.0.1', requestBody: null, responseBody: null,
    },
    [],
  );
}
s.logWriter.flush();
r.upstreamKeys.setStatus(openrouter.ks[0].id, 'cooldown', { cooldownUntil: now + 4 * 60_000, lastError: 'Rate limit exceeded' });
r.upstreamKeys.setStatus(groq.ks[4].id, 'invalid', { lastError: 'Invalid API Key' });
console.log('Seeded demo data: 4 providers, 18 keys, 8 models, 3 aliases, 3 gateway keys, 2000 requests.');
