import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db/client.js';
import { computeCost, estimateUsage } from '../src/logging/usage.js';
import { LogWriter, type NewRequestLog } from '../src/logging/logWriter.js';
import { pruneLogs } from '../src/logging/retention.js';

const HOUR = 3_600_000;

function log(over: Partial<NewRequestLog> = {}): NewRequestLog {
  return {
    ts: Date.UTC(2026, 9, 24, 10, 15),
    gatewayKeyId: 1,
    requestedModel: 'gpt',
    aliasId: null,
    providerId: 2,
    modelId: 3,
    upstreamKeyId: 4,
    endpoint: 'chat',
    stream: false,
    status: 'ok',
    httpStatus: 200,
    errorType: null,
    errorMessage: null,
    latencyMs: 100,
    ttftMs: null,
    attempts: 1,
    inputTokens: 10,
    outputTokens: 5,
    cachedReadTokens: 2,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    usageEstimated: false,
    clientIp: '127.0.0.1',
    requestBody: null,
    responseBody: null,
    ...over,
  };
}

describe('cost', () => {
  it('charges cached tokens at the cached rate and the rest at input rate', () => {
    const m = { priceInputPerM: 2, priceOutputPerM: 10, priceCachedReadPerM: 0.5, priceCacheWritePerM: 2.5 } as any;
    const c = computeCost({ input: 1_000_000, output: 100_000, cachedRead: 400_000, cacheWrite: 100_000, reasoning: 0, estimated: false }, m);
    // uncached input 500k*2 + cached 400k*0.5 + write 100k*2.5 + output 100k*10 = 1 + 0.2 + 0.25 + 1 = 2.45
    expect(c).toBeCloseTo(2.45, 6);
  });
  it('treats missing prices as zero and falls back cached→input price', () => {
    expect(computeCost({ input: 100, output: 100, cachedRead: 0, cacheWrite: 0, reasoning: 0, estimated: false }, {} as any)).toBe(0);
    const m = { priceInputPerM: 1, priceOutputPerM: 0 } as any;
    expect(computeCost({ input: 1_000_000, output: 0, cachedRead: 500_000, cacheWrite: 0, reasoning: 0, estimated: false }, m)).toBeCloseTo(1, 6);
  });
});

describe('estimateUsage', () => {
  it('estimates usage when missing', () => {
    const u = estimateUsage({ messages: [{ role: 'user', content: 'Hello there, how are you today?' }] }, 'I am fine, thanks for asking!');
    expect(u.input).toBeGreaterThan(3);
    expect(u.output).toBeGreaterThan(3);
    expect(u.estimated).toBe(true);
  });
  it('handles odd bodies without throwing', () => {
    expect(estimateUsage(null, '').input).toBe(0);
    expect(estimateUsage({ input: ['a', 'b'] }, '').input).toBeGreaterThan(0);
  });
});

describe('LogWriter', () => {
  it('flush writes logs, attempts and hour+day rollups in one go', () => {
    const db = openDb(':memory:');
    const w = new LogWriter(db);
    w.enqueue(log(), [{ n: 1, providerId: 2, upstreamKeyId: 4, modelId: 3, httpStatus: 200, errorType: null, errorMessage: null, latencyMs: 90 }]);
    w.enqueue(log({ inputTokens: 20 }), []);
    w.enqueue(log({ status: 'error', inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, costUsd: 0 }), []);
    w.flush();
    expect(db.prepare('SELECT count(*) c FROM request_logs').get()).toEqual({ c: 3 });
    expect(db.prepare('SELECT count(*) c FROM request_attempts').get()).toEqual({ c: 1 });
    const hour = db.prepare("SELECT * FROM usage_rollups WHERE bucket='hour'").all() as any[];
    expect(hour).toHaveLength(1);
    expect(hour[0]).toMatchObject({ requests: 3, errors: 1, input_tokens: 30, output_tokens: 10, cached_read_tokens: 4, latency_sum_ms: 300 });
    expect(hour[0].bucket_start).toBe(Date.UTC(2026, 9, 24, 10));
    expect(hour[0].cost_usd).toBeCloseTo(0.02, 6);
    const day = db.prepare("SELECT * FROM usage_rollups WHERE bucket='day'").get() as any;
    expect(day.bucket_start).toBe(Date.UTC(2026, 9, 24));
    expect(day.requests).toBe(3);
  });

  it('separate hours make separate rollup rows and null ids map to 0', () => {
    const db = openDb(':memory:');
    const w = new LogWriter(db);
    w.enqueue(log(), []);
    w.enqueue(log({ ts: log().ts + HOUR, providerId: null, modelId: null, upstreamKeyId: null }), []);
    w.flush();
    const rows = db.prepare("SELECT * FROM usage_rollups WHERE bucket='hour' ORDER BY bucket_start").all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[1].provider_id).toBe(0);
  });

  it('the 200th enqueue flushes synchronously', () => {
    const db = openDb(':memory:');
    const w = new LogWriter(db);
    for (let i = 0; i < 200; i++) w.enqueue(log(), []);
    expect(db.prepare('SELECT count(*) c FROM request_logs').get()).toEqual({ c: 200 });
  });

  it('flush failure does not throw and keeps rows for retry', () => {
    const db = openDb(':memory:');
    const w = new LogWriter(db);
    w.enqueue(log(), []);
    db.exec('ALTER TABLE request_logs RENAME TO rl_tmp');
    expect(() => w.flush()).not.toThrow();
    db.exec('ALTER TABLE rl_tmp RENAME TO request_logs');
    w.flush();
    expect(db.prepare('SELECT count(*) c FROM request_logs').get()).toEqual({ c: 1 });
  });

  it('notifies listeners with inserted ids', () => {
    const db = openDb(':memory:');
    const w = new LogWriter(db);
    const seen: number[] = [];
    w.onFlush((logs) => seen.push(...logs.map((l) => l.id)));
    w.enqueue(log(), []);
    w.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThan(0);
  });

  it('stop flushes the queue', async () => {
    const db = openDb(':memory:');
    const w = new LogWriter(db);
    w.start();
    w.enqueue(log(), []);
    await w.stop();
    expect(db.prepare('SELECT count(*) c FROM request_logs').get()).toEqual({ c: 1 });
  });
});

describe('pruneLogs', () => {
  it('removes old raw logs but keeps rollups', () => {
    const db = openDb(':memory:');
    const w = new LogWriter(db);
    const now = Date.UTC(2026, 9, 24);
    w.enqueue(log({ ts: now - 100 * 24 * HOUR }), [{ n: 1, providerId: 1, upstreamKeyId: 1, modelId: 1, httpStatus: 200, errorType: null, errorMessage: null, latencyMs: 1 }]);
    w.enqueue(log({ ts: now - HOUR }), []);
    w.flush();
    expect(pruneLogs(db, 90, now)).toBe(1);
    expect(db.prepare('SELECT count(*) c FROM request_logs').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT count(*) c FROM request_attempts').get()).toEqual({ c: 0 });
    expect((db.prepare("SELECT count(*) c FROM usage_rollups WHERE bucket='day'").get() as any).c).toBe(2);
  });
});
