# AI API Gateway — Design Spec

Date: 2026-10-24 · Owner: single admin (personal use) · Host: Windows PC, localhost

## 1. Goal

One self-hosted gateway that pools many upstream AI-provider API keys behind gateway-issued API keys. Every call rotates across the allowed upstream keys (and providers) so usage is distributed, with failover, full per-key control, and complete usage analytics in a professional dashboard.

Success criteria:
- Any OpenAI-compatible SDK works by changing only `baseURL` and API key.
- Successive calls on one gateway key rotate across its upstream key pool.
- One alias can be served by multiple providers.
- 429/5xx/timeouts fail over transparently (when not mid-stream).
- Dashboard shows requests, input/output/cached/reasoning tokens, cost, latency, errors — by gateway key, upstream key, provider, model, alias, over any time range.
- Process never crashes on bad input or upstream failure.

Non-goals: multi-tenant/team accounts, billing, cloud deployment, Docker, TLS.

## 2. Architecture

Single Node.js (TypeScript) process, one port (default `8787`, bound to `127.0.0.1`, configurable):
- `/v1/*` — gateway API (OpenAI-compatible + Anthropic-native passthrough)
- `/admin/api/*` — admin REST API (session-cookie auth)
- `/` — built React dashboard (static)

Stack: Fastify, undici, zod, better-sqlite3 + Drizzle ORM (migrations on boot, WAL mode), pino logging. Dashboard: React + Vite + TypeScript, Tailwind + shadcn/ui, TanStack Query, Recharts. Tests: Vitest, Playwright.

Repository layout (monorepo, npm workspaces):
```
server/src/
  index.ts            bootstrap, graceful shutdown
  config/             env loading + validation
  db/                 schema, migrations, repositories
  crypto/             AES-256-GCM secret box, key hashing
  adapters/           one file per provider + adapter interface
  router/             candidate builder, strategies, cooldown, limiter
  proxy/              /v1 handlers, streaming, usage extraction
  logging/            async batch log writer, rollups, retention
  admin/              admin routes
web/src/              dashboard
```

## 3. Data model

- **Provider**: id, name, type (`openai|anthropic|gemini|openrouter|groq|mistral|deepseek|xai|together|ollama|custom_openai`), baseUrl, extraHeaders (JSON), timeoutMs, enabled, priority, createdAt.
- **UpstreamKey**: id, providerId, label, secretEnc (AES-256-GCM), tags (JSON array), weight (default 1), rpmLimit, tpmLimit, dailyRequestCap, dailyTokenCap (all nullable), status (`active|cooldown|disabled|invalid`), cooldownUntil, lastError, lastUsedAt, createdAt.
- **Model**: id, providerId, upstreamModelId, displayName, contextLength, capabilities (JSON: chat, vision, tools, embeddings, reasoning), priceInputPerM, priceOutputPerM, priceCachedReadPerM, priceCacheWritePerM, source (`synced|manual`), enabled.
- **ModelAlias**: id, name (unique, public), description, enabled.
- **AliasTarget**: aliasId, modelId, weight, priority, enabled. (Every enabled Model is also addressable by `provider/upstreamModelId` without an alias.)
- **GatewayKey**: id, name, keyPrefix (shown), keyHash (SHA-256), enabled, expiresAt, allowedAliases (JSON | null = all), allowedModelIds (JSON | null = all), allowedProviderIds (JSON | null = all), pool (JSON: `{mode:"all"|"explicit"|"tags"|"providers", keyIds?, tags?, providerIds?}`), strategy (`round_robin|weighted|least_used|random|priority_failover`), maxRetries (default 3), rpmLimit, tpmLimit, budgetDailyUsd, budgetMonthlyUsd, tokenQuotaTotal, ipAllowlist (JSON), defaultParams (JSON, merged into requests), paramOverrides (JSON, forced), maxTokensCap, logBodies (bool), createdAt, lastUsedAt.
- **RequestLog**: id, ts, gatewayKeyId, requestedModel, aliasId, providerId, modelId, upstreamKeyId, endpoint, stream, status (`ok|error`), httpStatus, errorType, errorMessage, latencyMs, ttftMs, attempts, inputTokens, outputTokens, cachedReadTokens, cacheWriteTokens, reasoningTokens, costUsd, usageEstimated (bool), clientIp, requestBody?, responseBody? (only if logBodies).
- **RequestAttempt**: requestId, n, providerId, upstreamKeyId, httpStatus, errorType, latencyMs.
- **UsageRollup**: bucket (`hour|day`), bucketStart, gatewayKeyId, upstreamKeyId, providerId, modelId — requests, errors, input/output/cachedRead/cacheWrite/reasoning tokens, costUsd, latencySumMs. Upserted per log batch.
- **Settings**: key/value (admin password hash, retention days, default cooldowns, etc).

## 4. Request flow

1. Auth: `Authorization: Bearer gw-…` (or `x-api-key`) → hash lookup. Reject revoked/expired/IP-disallowed → 401/403.
2. Limits: in-memory sliding windows for gateway key RPM/TPM; budgets/quota checked against rollups (cached 10s) → 429 `gateway_limit`.
3. Resolve model: alias name → AliasTargets; or `provider/model` direct; filter by key scope. Empty → 404 `model_not_allowed`.
4. Candidates: cross product of targets × pool keys belonging to the target's provider, filtered to status active (or cooldown expired), under per-key limits/caps.
5. Strategy orders the candidates:
   - `round_robin`: persistent cursor per gateway key (in memory, persisted to Settings every 30s) over the flattened candidate list.
   - `weighted`: weighted random by key weight × target weight.
   - `least_used`: fewest requests in the last 60s.
   - `random`.
   - `priority_failover`: lowest target priority first, round-robin within a tier.
6. Attempt loop (≤ maxRetries+1): adapter translates request → undici call with timeout → on success, stream/return; on failure, classify:
   - 429 → key cooldown = Retry-After or exponential (30s, 60s, 120s… max 15m) → next.
   - 5xx / network / timeout → short cooldown (15s) → next.
   - 401/403 → status `invalid`, dashboard alert → next.
   - 400/404/413/422 (client error) → return as-is, no retry.
   - Mid-stream failure → terminate stream with OpenAI-style error chunk; no failover.
7. Usage: from provider response/final stream chunk (`stream_options.include_usage` injected for OpenAI-compatible); else estimate with tokenizer and flag `usageEstimated`. Cost = tokens × Model prices.
8. Log: enqueue RequestLog + attempts; batch writer flushes every 1s or 200 rows, in one transaction, and upserts rollups.

Endpoints: `POST /v1/chat/completions`, `POST /v1/completions`, `POST /v1/embeddings`, `GET /v1/models` (scoped to key), `POST /v1/messages` (Anthropic format; routed to Anthropic providers only).

## 5. Adapters

Interface:
```ts
interface ProviderAdapter {
  listModels(p: Provider, key: string): Promise<ModelInfo[]>;
  buildRequest(endpoint, body: OpenAIRequest, model: Model, p: Provider, key: string): UpstreamRequest;
  parseResponse(json): { body: OpenAIResponse; usage: Usage };
  parseStream(chunks: AsyncIterable<Buffer>): AsyncIterable<{ chunk?: OpenAIChunk; usage?: Usage }>;
  classifyError(status, body, headers): ErrorClass;
}
```
- OpenAI-compatible base adapter: openai, openrouter, groq, mistral, deepseek, xai, together, ollama, custom_openai (differences in config: base URL, usage fields, model-list shape).
- Anthropic adapter: messages translation (system, tools, images), cache_read/cache_creation tokens, SSE event mapping.
- Gemini adapter: generateContent / streamGenerateContent translation, usageMetadata (incl. cachedContentTokenCount, thoughtsTokenCount).

## 6. Error handling & robustness

- zod validation on every admin and gateway input; uniform error body `{error:{type,code,message}}`.
- Fastify global error handler; `process.on('unhandledRejection'|'uncaughtException')` logs and keeps serving (fatal only for DB open failure at boot).
- Graceful shutdown: stop accepting, drain in-flight (30s), flush log queue, close DB.
- Upstream secrets encrypted with AES-256-GCM, master key `GATEWAY_MASTER_KEY` in `.env` (generated on first run if absent). Gateway keys shown once, stored as SHA-256 hashes.
- Admin auth: password (argon2/scrypt hash) set on first run; httpOnly session cookie; login rate-limited.
- Request body limit (default 20 MB), upstream timeout per provider, client-abort propagates to upstream.
- `/health` endpoint; per-upstream-key "Test" button (cheap model list/1-token call).

## 7. Dashboard

Pages: Overview (KPIs, time series, top lists, alerts) · Providers (CRUD, test, sync models) · Upstream Keys (table, bulk paste, tags/weights, live status/cooldown, per-key usage) · Models & Aliases (catalog, price edit, alias builder with multi-provider targets) · Gateway Keys (create wizard: scope, pool, strategy, limits, budget, expiry, overrides; show-once secret; regenerate/revoke; usage) · Logs (search/filter, detail drawer with attempts and routing) · Analytics (any metric × any dimension × time range, cache hit ratio, cost trend, CSV export) · Settings (password, retention, defaults, DB backup/restore, config JSON import/export). Light/dark theme.

## 8. Analytics & retention

Charts read UsageRollup (hour buckets for ≤7 days, day buckets beyond). Raw RequestLog pruned after `retentionDays` (default 90) by a daily job; rollups kept indefinitely. Cache hit ratio = cachedRead / input.

## 9. Testing

- Unit: strategies, candidate builder, cooldown classifier, limiter, cost calc, each adapter's translation (fixtures).
- Integration: mock provider servers — non-stream/stream success, 429→failover, 401→invalid, mid-stream failure, usage capture, scope rejection.
- E2E: Playwright smoke (login, create provider/key/gateway key, see a logged request).

## 10. Running

`npm install`, `npm run build`, `npm start` → http://127.0.0.1:8787. Optional: install as Windows service via `node-windows` script. Data in `./data/gateway.db`.
