import { tx, type Db } from '../db/client.js';

export interface NewRequestLog {
  ts: number;
  gatewayKeyId: number | null;
  requestedModel: string | null;
  aliasId: number | null;
  providerId: number | null;
  modelId: number | null;
  upstreamKeyId: number | null;
  endpoint: string;
  stream: boolean;
  status: 'ok' | 'error';
  httpStatus: number | null;
  errorType: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  usageEstimated: boolean;
  clientIp: string | null;
  requestBody: string | null;
  responseBody: string | null;
}

export interface NewAttempt {
  n: number;
  providerId: number | null;
  upstreamKeyId: number | null;
  modelId: number | null;
  httpStatus: number | null;
  errorType: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
}

interface Item {
  log: NewRequestLog;
  attempts: NewAttempt[];
  tries: number;
}

const FLUSH_MS = 1000;
const FLUSH_AT = 200;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const LOG_COLS = [
  'ts', 'gateway_key_id', 'requested_model', 'alias_id', 'provider_id', 'model_id', 'upstream_key_id', 'endpoint', 'stream',
  'status', 'http_status', 'error_type', 'error_message', 'latency_ms', 'ttft_ms', 'attempts', 'input_tokens', 'output_tokens',
  'cached_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'cost_usd', 'usage_estimated', 'client_ip', 'request_body', 'response_body',
];

type Logger = { error: (obj: unknown, msg?: string) => void };

/** Batches request logs off the hot path; each flush is one transaction that also upserts usage rollups. */
export class LogWriter {
  private queue: Item[] = [];
  private timer: NodeJS.Timeout | null = null;
  private listeners: ((logs: (NewRequestLog & { id: number })[]) => void)[] = [];

  constructor(
    private db: Db,
    private logger: Logger = { error: (o, m) => console.error(m ?? 'log writer error', o) },
  ) {}

  onFlush(fn: (logs: (NewRequestLog & { id: number })[]) => void): void {
    this.listeners.push(fn);
  }

  enqueue(log: NewRequestLog, attempts: NewAttempt[]): void {
    this.queue.push({ log, attempts, tries: 0 });
    if (this.queue.length >= FLUSH_AT) this.flush();
  }

  get pending(): number {
    return this.queue.length;
  }

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), FLUSH_MS);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  flush(): void {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    let written: (NewRequestLog & { id: number })[] = [];
    try {
      written = tx(this.db, () => this.write(batch));
    } catch (err) {
      const retry = batch.filter((b) => ++b.tries < 2);
      this.queue.unshift(...retry);
      this.logger.error({ err, dropped: batch.length - retry.length }, 'request log flush failed');
      return;
    }
    for (const fn of this.listeners) {
      try {
        fn(written);
      } catch (err) {
        this.logger.error({ err }, 'log flush listener failed');
      }
    }
  }

  private write(batch: Item[]) {
    const insLog = this.db.prepare(`INSERT INTO request_logs(${LOG_COLS.join(',')}) VALUES(${LOG_COLS.map(() => '?').join(',')})`);
    const insAttempt = this.db.prepare(
      'INSERT INTO request_attempts(request_id,n,provider_id,upstream_key_id,model_id,http_status,error_type,error_message,latency_ms) VALUES(?,?,?,?,?,?,?,?,?)',
    );
    const upsert = this.db.prepare(`
      INSERT INTO usage_rollups(bucket,bucket_start,gateway_key_id,upstream_key_id,provider_id,model_id,requests,errors,
        input_tokens,output_tokens,cached_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd,latency_sum_ms)
      VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)
      ON CONFLICT(bucket,bucket_start,gateway_key_id,upstream_key_id,provider_id,model_id) DO UPDATE SET
        requests = requests + 1, errors = errors + excluded.errors,
        input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
        cached_read_tokens = cached_read_tokens + excluded.cached_read_tokens, cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens, cost_usd = cost_usd + excluded.cost_usd,
        latency_sum_ms = latency_sum_ms + excluded.latency_sum_ms`);
    const out: (NewRequestLog & { id: number })[] = [];
    for (const { log: l, attempts } of batch) {
      const id = Number(
        insLog.run(
          l.ts, l.gatewayKeyId, l.requestedModel, l.aliasId, l.providerId, l.modelId, l.upstreamKeyId, l.endpoint, l.stream ? 1 : 0,
          l.status, l.httpStatus, l.errorType, l.errorMessage, l.latencyMs, l.ttftMs, l.attempts, l.inputTokens, l.outputTokens,
          l.cachedReadTokens, l.cacheWriteTokens, l.reasoningTokens, l.costUsd, l.usageEstimated ? 1 : 0, l.clientIp, l.requestBody, l.responseBody,
        ).lastInsertRowid,
      );
      for (const a of attempts) {
        insAttempt.run(id, a.n, a.providerId, a.upstreamKeyId, a.modelId, a.httpStatus, a.errorType, a.errorMessage, a.latencyMs);
      }
      for (const [bucket, size] of [['hour', HOUR], ['day', DAY]] as const) {
        upsert.run(
          bucket, Math.floor(l.ts / size) * size, l.gatewayKeyId ?? 0, l.upstreamKeyId ?? 0, l.providerId ?? 0, l.modelId ?? 0,
          l.status === 'error' ? 1 : 0, l.inputTokens, l.outputTokens, l.cachedReadTokens, l.cacheWriteTokens, l.reasoningTokens, l.costUsd, l.latencyMs ?? 0,
        );
      }
      out.push({ ...l, id });
    }
    return out;
  }
}
