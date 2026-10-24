import { z } from 'zod';
import { must, type AdminContext } from '../context.js';
import { groupBy, idParam, logsQuery, metric, rangeQuery } from '../schemas.js';
import { latencyPercentiles, metricValue, resolveRange, timeseries, toCsv, top, totals, GROUP_COL } from '../analytics.js';

const LOG_LIST_COLS = `id, ts, gateway_key_id, requested_model, alias_id, provider_id, model_id, upstream_key_id, endpoint, stream, status,
  http_status, error_type, error_message, latency_ms, ttft_ms, attempts, input_tokens, output_tokens, cached_read_tokens,
  cache_write_tokens, reasoning_tokens, cost_usd, usage_estimated, client_ip`;

const camel = (row: Record<string, any>) => {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v;
  if ('stream' in out) out.stream = !!out.stream;
  if ('usageEstimated' in out) out.usageEstimated = !!out.usageEstimated;
  return out;
};

const filterQuery = z.object({
  gatewayKeyId: z.coerce.number().int().optional(),
  upstreamKeyId: z.coerce.number().int().optional(),
  providerId: z.coerce.number().int().optional(),
  modelId: z.coerce.number().int().optional(),
});

/** At most one dimension filter for analytics, e.g. a single gateway key's detail page. */
function dimFilter(q: z.infer<typeof filterQuery>) {
  if (q.gatewayKeyId) return { col: GROUP_COL.gatewayKey, id: q.gatewayKeyId };
  if (q.upstreamKeyId) return { col: GROUP_COL.upstreamKey, id: q.upstreamKeyId };
  if (q.providerId) return { col: GROUP_COL.provider, id: q.providerId };
  if (q.modelId) return { col: GROUP_COL.model, id: q.modelId };
  return null;
}

export function insightRoutes({ app, s }: AdminContext) {
  app.get('/logs', async (req) => {
    const q = logsQuery.parse(req.query);
    const where: string[] = [];
    const args: any[] = [];
    const add = (sql: string, v: unknown) => {
      where.push(sql);
      args.push(v);
    };
    if (q.from !== undefined) add('ts >= ?', q.from);
    if (q.to !== undefined) add('ts <= ?', q.to);
    if (q.gatewayKeyId) add('gateway_key_id = ?', q.gatewayKeyId);
    if (q.providerId) add('provider_id = ?', q.providerId);
    if (q.modelId) add('model_id = ?', q.modelId);
    if (q.upstreamKeyId) add('upstream_key_id = ?', q.upstreamKeyId);
    if (q.status) add('status = ?', q.status);
    if (q.cursor) add('id < ?', q.cursor);
    if (q.q) {
      where.push('(requested_model LIKE ? OR error_message LIKE ? OR error_type LIKE ?)');
      const like = `%${q.q.replace(/[%_]/g, (c) => '\\' + c)}%`;
      args.push(like, like, like);
    }
    const sql = `SELECT ${LOG_LIST_COLS} FROM request_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    const items = (s.db.prepare(sql).all(...args, q.limit + 1) as any[]).map(camel);
    const more = items.length > q.limit;
    if (more) items.pop();
    return { items, nextCursor: more ? items.at(-1)!.id : null };
  });

  app.get('/logs/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const row = must(s.db.prepare('SELECT * FROM request_logs WHERE id = ?').get(id) as any, 'Log');
    const attempts = (s.db.prepare('SELECT * FROM request_attempts WHERE request_id = ? ORDER BY n').all(id) as any[]).map(camel);
    return { ...camel(row), attempts };
  });

  app.get('/analytics/summary', async (req) => {
    const r = resolveRange(rangeQuery.parse(req.query));
    const f = dimFilter(filterQuery.parse(req.query));
    const t = totals(s.db, r.from, r.to, f);
    return {
      from: r.from,
      to: r.to,
      ...t,
      totalTokens: metricValue(t, 'totalTokens'),
      avgLatencyMs: metricValue(t, 'avgLatencyMs'),
      cacheHitRatio: metricValue(t, 'cacheHitRatio'),
      errorRate: metricValue(t, 'errorRate'),
      ...latencyPercentiles(s.db, r.from, r.to, f),
    };
  });

  app.get('/analytics/timeseries', async (req) => {
    const q = z.object({ metric: metric.default('requests'), groupBy: groupBy.default('none') }).parse(req.query);
    return timeseries(s.db, s.repos, rangeQuery.parse(req.query), q.metric, q.groupBy, dimFilter(filterQuery.parse(req.query)));
  });

  app.get('/analytics/top', async (req) => {
    const q = z
      .object({ dimension: groupBy.exclude(['none']), metric: metric.default('requests'), limit: z.coerce.number().int().min(1).max(100).default(10) })
      .parse(req.query);
    return top(s.db, s.repos, rangeQuery.parse(req.query), q.dimension, q.metric, q.limit);
  });

  app.get('/analytics/export.csv', async (req, reply) => {
    const q = z.object({ groupBy: groupBy.default('none') }).parse(req.query);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="gateway-usage.csv"');
    return toCsv(s.db, s.repos, rangeQuery.parse(req.query), q.groupBy);
  });

  app.get('/alerts', async () => {
    const now = Date.now();
    const providers = new Map(s.repos.providers.list().map((p) => [p.id, p.name]));
    const alerts: { kind: string; severity: 'error' | 'warning' | 'info'; message: string; ref: { type: string; id: number } }[] = [];
    for (const k of s.repos.upstreamKeys.list()) {
      const where = `${providers.get(k.providerId) ?? '?'} · ${k.label}`;
      if (k.status === 'invalid') alerts.push({ kind: 'key_invalid', severity: 'error', message: `${where} is invalid: ${k.lastError ?? 'rejected by provider'}`, ref: { type: 'upstreamKey', id: k.id } });
      else if (k.status === 'cooldown' && (k.cooldownUntil ?? 0) > now) {
        alerts.push({ kind: 'key_cooldown', severity: 'warning', message: `${where} is cooling down until ${new Date(k.cooldownUntil!).toISOString()}`, ref: { type: 'upstreamKey', id: k.id } });
      }
    }
    s.usage.clear();
    for (const g of s.repos.gatewayKeys.list()) {
      const spend = s.usage.gatewaySpend(g.id, now);
      const check = (limit: number | null, used: number, label: string) => {
        if (limit && used >= 0.8 * limit) {
          alerts.push({ kind: 'budget', severity: used >= limit ? 'error' : 'warning', message: `${g.name}: ${label} at ${Math.round((used / limit) * 100)}%`, ref: { type: 'gatewayKey', id: g.id } });
        }
      };
      check(g.budgetDailyUsd, spend.dayUsd, 'daily budget');
      check(g.budgetMonthlyUsd, spend.monthUsd, 'monthly budget');
      check(g.tokenQuotaTotal, spend.totalTokens, 'token quota');
      if (g.expiresAt && g.expiresAt > now && g.expiresAt - now < 3 * 86_400_000) {
        alerts.push({ kind: 'expiring', severity: 'info', message: `${g.name} expires ${new Date(g.expiresAt).toISOString()}`, ref: { type: 'gatewayKey', id: g.id } });
      }
    }
    return alerts;
  });
}
