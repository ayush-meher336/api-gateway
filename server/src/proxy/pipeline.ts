import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAdapter } from '../adapters/registry.js';
import { parseSse, formatSse } from '../adapters/sse.js';
import type { Endpoint, ErrorClass, Usage } from '../adapters/types.js';
import { DecryptError } from '../crypto/secretBox.js';
import type { GatewayKey, UpstreamKey } from '../db/types.js';
import { GatewayError } from '../errors.js';
import type { NewAttempt, NewRequestLog } from '../logging/logWriter.js';
import { computeCost, estimateUsage } from '../logging/usage.js';
import { buildCandidates, soonestCooldown, type Candidate } from '../router/candidates.js';
import { nextCooldown } from '../router/cooldown.js';
import { resolveTargets } from '../router/resolve.js';
import { orderCandidates } from '../router/strategies.js';
import type { Services } from '../services.js';
import { authenticate } from './auth.js';

const BODY_LOG_LIMIT = 256 * 1024;
const truncate = (s: string) => (s.length > BODY_LOG_LIMIT ? s.slice(0, BODY_LOG_LIMIT) + '…[truncated]' : s);

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

type AttemptResult =
  | { kind: 'done' }
  | { kind: 'final' }
  | { kind: 'aborted' }
  | { kind: 'retry'; status: number; message: string };

/** Fills defaults for missing fields, forces overrides, and caps output tokens. */
export function applyParams(endpoint: Endpoint, body: any, gk: GatewayKey): any {
  const { model: _ignored, ...overrides } = gk.paramOverrides ?? {};
  const out = { ...(gk.defaultParams ?? {}), ...body, ...overrides };
  if (gk.maxTokensCap && endpoint !== 'embeddings') {
    let capped = false;
    for (const f of ['max_tokens', 'max_completion_tokens']) {
      if (typeof out[f] === 'number') {
        out[f] = Math.min(out[f], gk.maxTokensCap);
        capped = true;
      }
    }
    if (!capped) out.max_tokens = gk.maxTokensCap;
  }
  return out;
}

export function upstreamMessage(text: string, status: number): string {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : null) ?? j?.[0]?.error?.message;
    if (m) return String(m).slice(0, 1000);
  } catch {
    /* not json */
  }
  return text ? text.slice(0, 1000) : `Upstream returned HTTP ${status}`;
}

function responseText(body: any): string {
  const msg = body?.choices?.[0]?.message;
  if (typeof msg?.content === 'string') return msg.content;
  if (typeof body?.choices?.[0]?.text === 'string') return body.choices[0].text;
  if (Array.isArray(body?.content)) return body.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return '';
}

function newLog(endpoint: Endpoint, req: FastifyRequest): NewRequestLog {
  return {
    ts: Date.now(), gatewayKeyId: null, requestedModel: null, aliasId: null, providerId: null, modelId: null, upstreamKeyId: null,
    endpoint, stream: false, status: 'ok', httpStatus: null, errorType: null, errorMessage: null, latencyMs: null, ttftMs: null,
    attempts: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0,
    usageEstimated: false, clientIp: req.ip, requestBody: null, responseBody: null,
  };
}

/** Runs one proxied request end to end: auth → resolve → rotate/failover → respond → log. */
export async function handleProxy(endpoint: Endpoint, req: FastifyRequest, reply: FastifyReply, s: Services): Promise<void> {
  const started = Date.now();
  const log = newLog(endpoint, req);
  const attempts: NewAttempt[] = [];
  const clientAc = new AbortController();
  let clientGone = false;
  const onClose = () => {
    if (!reply.raw.writableFinished) {
      clientGone = true;
      clientAc.abort();
    }
  };
  reply.raw.on('close', onClose);

  const setError = (status: number, type: string, message: string) => {
    log.status = 'error';
    log.httpStatus = status;
    log.errorType = type;
    log.errorMessage = message.slice(0, 2000);
  };
  const setUsage = (u: Usage, c: Candidate) => {
    log.inputTokens = u.input;
    log.outputTokens = u.output;
    log.cachedReadTokens = u.cachedRead;
    log.cacheWriteTokens = u.cacheWrite;
    log.reasoningTokens = u.reasoning;
    log.usageEstimated = u.estimated;
    log.costUsd = computeCost(u, c.model);
  };

  try {
    const gk = authenticate(req, s, started);
    log.gatewayKeyId = gk.id;
    const body = req.body as any;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new GatewayError(400, 'invalid_request_error', 'invalid_body', 'Request body must be a JSON object');
    }
    log.requestedModel = typeof body.model === 'string' ? body.model : null;
    const reqBody = applyParams(endpoint, body, gk);
    log.stream = endpoint !== 'embeddings' && !!reqBody.stream;
    if (gk.logBodies) log.requestBody = truncate(JSON.stringify(body));

    const snap = s.snapshots.get();
    const resolved = resolveTargets(body.model, gk, snap);
    log.aliasId = resolved.aliasId;
    const targets = resolved.targets.filter((t) => getAdapter(snap.providers.get(t.model.providerId)!.type).supports(endpoint));
    if (!targets.length) {
      throw new GatewayError(400, 'invalid_request_error', 'endpoint_not_supported', `No provider for "${body.model}" supports this endpoint`);
    }

    const now = Date.now();
    const cands = buildCandidates(gk, targets, snap, now, { allows: (k) => keyAllowed(s, k) });
    const ordered = orderCandidates(gk.strategy, gk.id, cands, s.router).slice(0, Math.max(1, gk.maxRetries + 1));
    if (!ordered.length) {
      const soon = soonestCooldown(gk, targets, snap);
      throw new GatewayError(
        503, 'service_unavailable', 'no_available_upstream',
        'No upstream key is currently available for this model' + (soon ? `; the next key frees up at ${new Date(soon).toISOString()}` : ''),
      );
    }
    s.limiter.record('gw', gk.id, 0);
    s.repos.gatewayKeys.touch(gk.id, now);

    let last: { status: number; message: string } | null = null;
    for (let i = 0; i < ordered.length && !clientGone; i++) {
      const r = await attemptOnce(ordered[i], i + 1);
      if (r.kind === 'retry') {
        last = r;
        continue;
      }
      return;
    }
    if (clientGone) {
      setError(499, 'client_aborted', 'Client disconnected');
      return;
    }
    throw new GatewayError(502, 'upstream_error', 'all_upstreams_failed', `All upstream attempts failed. Last error: ${last?.message ?? 'unknown'}`);

    async function attemptOnce(c: Candidate, n: number): Promise<AttemptResult> {
      const t0 = Date.now();
      const rec = (httpStatus: number | null, errorType: string | null, errorMessage: string | null) =>
        attempts.push({ n, providerId: c.provider.id, upstreamKeyId: c.key.id, modelId: c.model.id, httpStatus, errorType, errorMessage: errorMessage?.slice(0, 1000) ?? null, latencyMs: Date.now() - t0 });
      log.providerId = c.provider.id;
      log.modelId = c.model.id;
      log.upstreamKeyId = c.key.id;

      let secret: string;
      try {
        secret = s.repos.upstreamKeys.getSecret(c.key.id);
      } catch (err) {
        const msg = err instanceof DecryptError ? 'decrypt_failed' : String((err as Error).message);
        s.setKeyStatus(c.key.id, 'invalid', { lastError: msg });
        rec(null, 'decrypt_failed', msg);
        return { kind: 'retry', status: 500, message: 'stored key could not be decrypted' };
      }

      const adapter = getAdapter(c.provider.type);
      const ureq = adapter.buildRequest(endpoint, reqBody, c.model.upstreamModelId, c.provider, secret);
      s.limiter.record('up', c.key.id, 0);
      s.router.recordUse(c.key.id);

      const ac = new AbortController();
      const abortAttempt = () => ac.abort();
      clientAc.signal.addEventListener('abort', abortAttempt);
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const armTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, c.provider.timeoutMs);
      };
      armTimer();

      const fail = (cls: ErrorClass, message: string, retryAfter?: string | null) => {
        const streak = (c.key.failStreak ?? 0) + 1;
        const next = nextCooldown(cls, streak, retryAfter ?? undefined, Date.now());
        if (next) s.setKeyStatus(c.key.id, next.status, { cooldownUntil: next.cooldownUntil ?? null, lastError: message.slice(0, 500), failStreak: streak });
      };
      const succeed = (u: Usage) => {
        const ts = Date.now();
        if (c.key.status !== 'active' || c.key.failStreak) s.setKeyStatus(c.key.id, 'active', { cooldownUntil: null, failStreak: 0 });
        s.repos.upstreamKeys.touch(c.key.id, ts);
        s.snapshots.updateKey(c.key.id, { lastUsedAt: ts });
        const total = u.input + u.output;
        s.limiter.addTokens('gw', gk.id, total);
        s.limiter.addTokens('up', c.key.id, total);
      };
      const aborted = (textSoFar: string): AttemptResult => {
        rec(null, 'client_aborted', 'Client disconnected');
        setError(499, 'client_aborted', 'Client disconnected');
        if (textSoFar) setUsage(estimateUsage(reqBody, textSoFar), c);
        return { kind: 'aborted' };
      };

      try {
        let res: Response;
        try {
          res = await s.fetchFn(ureq.url, { method: ureq.method, headers: ureq.headers, body: ureq.body, signal: ac.signal });
        } catch (err) {
          if (clientGone) return aborted('');
          const msg = timedOut ? `Upstream timed out after ${c.provider.timeoutMs}ms` : `Network error: ${(err as Error).message}`;
          rec(null, timedOut ? 'timeout' : 'network_error', msg);
          fail('server_error', msg);
          return { kind: 'retry', status: timedOut ? 504 : 502, message: msg };
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const cls = adapter.classifyError(res.status);
          const msg = upstreamMessage(text, res.status);
          rec(res.status, cls, msg);
          if (cls === 'client_error') {
            setError(res.status, 'upstream_client_error', msg);
            reply.code(res.status).send({ error: { type: 'upstream_error', code: `upstream_${res.status}`, message: msg } });
            return { kind: 'final' };
          }
          fail(cls, msg, res.headers.get('retry-after'));
          return { kind: 'retry', status: res.status, message: msg };
        }

        if (!log.stream) {
          let json: any;
          try {
            json = JSON.parse(await res.text());
          } catch (err) {
            if (clientGone) return aborted('');
            const msg = timedOut ? `Upstream timed out after ${c.provider.timeoutMs}ms` : 'Upstream returned an invalid JSON body';
            rec(res.status, 'server_error', msg);
            fail('server_error', msg);
            return { kind: 'retry', status: 502, message: msg };
          }
          const parsed = adapter.parseResponse(endpoint, json);
          const usage = parsed.usage ?? estimateUsage(reqBody, responseText(parsed.body));
          rec(res.status, null, null);
          succeed(usage);
          setUsage(usage, c);
          log.httpStatus = 200;
          if (gk.logBodies) log.responseBody = truncate(JSON.stringify(parsed.body));
          reply.code(200).header('content-type', 'application/json; charset=utf-8').send(parsed.body);
          return { kind: 'done' };
        }

        // Streaming: headers go out only with the first chunk, so a failure before that can still fail over.
        let headersSent = false;
        let usage: Usage | null = null;
        let text = '';
        const startStream = () => {
          if (headersSent) return;
          reply.hijack();
          reply.raw.writeHead(200, SSE_HEADERS);
          headersSent = true;
          log.ttftMs = Date.now() - started;
        };
        try {
          for await (const item of adapter.parseStream(endpoint, parseSse(res.body as any))) {
            armTimer();
            if (item.raw || item.chunk) startStream();
            if (item.raw) reply.raw.write(formatSse(item.raw.data, item.raw.event));
            else if (item.chunk) reply.raw.write(formatSse(item.chunk));
            if (item.usage) usage = item.usage;
            if (item.text !== undefined) text = item.text;
          }
        } catch (err) {
          if (clientGone) return aborted(text);
          const msg = timedOut ? `Upstream stream idle for ${c.provider.timeoutMs}ms` : `Stream interrupted: ${(err as Error).message}`;
          if (!headersSent) {
            rec(res.status, 'stream_error', msg);
            fail('server_error', msg);
            return { kind: 'retry', status: 502, message: msg };
          }
          rec(res.status, 'stream_interrupted', msg);
          setError(200, 'stream_interrupted', msg);
          setUsage(usage ?? estimateUsage(reqBody, text), c);
          reply.raw.write(formatSse({ error: { type: 'upstream_error', code: 'stream_interrupted', message: msg } }));
          if (endpoint !== 'messages') reply.raw.write('data: [DONE]\n\n');
          reply.raw.end();
          return { kind: 'done' };
        }
        if (clientGone) return aborted(text);
        startStream();
        if (endpoint !== 'messages') reply.raw.write('data: [DONE]\n\n');
        const finalUsage = usage ?? estimateUsage(reqBody, text);
        rec(res.status, null, null);
        succeed(finalUsage);
        setUsage(finalUsage, c);
        log.httpStatus = 200;
        if (gk.logBodies) log.responseBody = truncate(text);
        reply.raw.end();
        return { kind: 'done' };
      } finally {
        clearTimeout(timer);
        clientAc.signal.removeEventListener('abort', abortAttempt);
      }
    }
  } catch (err) {
    const ge =
      err instanceof GatewayError
        ? err
        : new GatewayError(500, 'internal_error', 'internal_error', 'The gateway hit an unexpected error');
    if (!(err instanceof GatewayError)) s.logger.error({ err }, 'proxy handler failed');
    setError(ge.status, ge.code, err instanceof GatewayError ? ge.message : String((err as Error)?.message ?? err));
    if (!reply.sent && !reply.raw.headersSent) reply.code(ge.status).send(ge.toBody());
    else if (!reply.raw.writableEnded) reply.raw.end();
  } finally {
    reply.raw.off('close', onClose);
    log.latencyMs = Date.now() - started;
    log.attempts = attempts.length;
    s.logWriter.enqueue(log, attempts);
  }
}

function keyAllowed(s: Services, k: UpstreamKey): boolean {
  if (!s.limiter.check('up', k.id, { rpm: k.rpmLimit, tpm: k.tpmLimit })) return false;
  if (k.dailyRequestCap == null && k.dailyTokenCap == null) return true;
  const d = s.usage.upstreamDaily(k.id);
  if (k.dailyRequestCap != null && d.requests >= k.dailyRequestCap) return false;
  if (k.dailyTokenCap != null && d.tokens >= k.dailyTokenCap) return false;
  return true;
}
