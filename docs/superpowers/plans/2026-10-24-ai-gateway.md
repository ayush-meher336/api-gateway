# AI API Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-process localhost gateway that pools many provider API keys behind gateway keys, rotates every call across the allowed pool with failover, and exposes full usage analytics in a React dashboard.

**Architecture:** Node/TypeScript Fastify server serving `/v1/*` (proxy), `/admin/api/*` (admin REST) and the built dashboard from one port. SQLite (better-sqlite3 + Drizzle) holds config, logs and rollups. Provider differences are isolated in adapters behind one interface; routing (candidates → strategy → attempt loop) is pure and unit-tested.

**Tech Stack:** Node 22, TypeScript 5, Fastify 5, undici, zod, better-sqlite3, drizzle-orm/drizzle-kit, pino, gpt-tokenizer, Vitest; web: React 18, Vite, Tailwind, shadcn/ui, TanStack Query, Recharts, react-router; Playwright.

**Spec:** `docs/superpowers/specs/2026-10-24-ai-gateway-design.md`

## Global Constraints

- Default bind `127.0.0.1:8787` (`HOST`, `PORT` env override). Data at `./data/gateway.db`, WAL mode, migrations on boot.
- Every error response body: `{error:{type,code,message}}`.
- Upstream secrets AES-256-GCM with `GATEWAY_MASTER_KEY` (32-byte hex in `.env`, generated on first run if absent). Gateway keys format `gw-` + 40 random base62 chars; store SHA-256 hash + first 10 chars as `keyPrefix`; plaintext returned only at create/regenerate.
- Defaults: `maxRetries` 3; 429 cooldown = `Retry-After` else 30s·2^(n-1) capped 15m; 5xx/network/timeout cooldown 15s; body limit 20 MB; retention 90 days; log flush every 1s or 200 rows; budget cache 10s; RR cursor persisted every 30s; graceful drain 30s.
- Provider types: `openai|anthropic|gemini|openrouter|groq|mistral|deepseek|xai|together|ollama|custom_openai`.
- Strategies: `round_robin|weighted|least_used|random|priority_failover`.
- All tests run on Windows (`npm test` from repo root). No Docker.

## Review Focus

1. Client disconnects mid-stream → upstream request aborted, log row written with `errorType:"client_aborted"`, no crash. (Task 9 test `aborts upstream on client disconnect`.)
2. Every key in the pool cooling down/invalid → 503 `no_available_upstream` with soonest cooldown in message, not a hang or 500. (Task 7 test `all keys unavailable`.)
3. Master key changed/missing after secrets were stored → decrypt fails → key marked `invalid` with `lastError:"decrypt_failed"`, server keeps running. (Task 2 test `wrong master key throws DecryptError`; Task 9 test `decrypt failure marks key invalid`.)
4. Provider returns no usage (some streams, Ollama) → tokens estimated, `usageEstimated=true`, cost still computed. (Task 8 test `estimates usage when missing`.)
5. Alias pointing at a disabled model/provider, or pool referencing deleted keys → those candidates silently dropped, others still served. (Task 6 test `skips disabled and dangling refs`.)

---

### Task 1: Monorepo scaffold, config, DB schema & migrations

**Files:**
- Create: `package.json` (workspaces `server`, `web`; scripts `build`, `start`, `dev`, `test`), `tsconfig.base.json`, `.gitignore` (`node_modules`, `data`, `.env`, `dist`), `.env.example`
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`
- Create: `server/src/config/env.ts`, `server/src/db/schema.ts`, `server/src/db/client.ts`, `server/drizzle.config.ts`, `server/drizzle/*` (generated)
- Test: `server/test/db.test.ts`

**Interfaces:**
- Produces: `loadEnv(): Env` (`{host, port, dataDir, masterKey: Buffer, logLevel}`; creates `.env` with a generated master key if missing). `openDb(file: string): Db` (runs migrations, `PRAGMA journal_mode=WAL`, `foreign_keys=ON`). Drizzle tables exactly per spec §3: `providers, upstreamKeys, models, modelAliases, aliasTargets, gatewayKeys, requestLogs, requestAttempts, usageRollups, settings`. JSON columns use `text({mode:'json'})`; timestamps are integer ms. `usageRollups` unique index on `(bucket, bucketStart, gatewayKeyId, upstreamKeyId, providerId, modelId)` (nullable ids stored as 0). Indexes: `requestLogs(ts)`, `requestLogs(gatewayKeyId, ts)`.

- [ ] **Step 1: Write failing test** — `openDb(':memory:')` then insert a provider and upstream key, read back; assert `PRAGMA foreign_keys` = 1; deleting the provider cascades its keys.
- [ ] **Step 2:** Run `npm test -w server` → FAIL (module missing).
- [ ] **Step 3:** Implement schema, `openDb`, `loadEnv`; generate migration with `npx drizzle-kit generate`.
- [ ] **Step 4:** Run `npm test -w server` → PASS.
- [ ] **Step 5:** Commit `feat: scaffold monorepo, config and db schema`.

### Task 2: Crypto — secret box and gateway key generation

**Files:**
- Create: `server/src/crypto/secretBox.ts`, `server/src/crypto/gatewayKey.ts`
- Test: `server/test/crypto.test.ts`

**Interfaces:**
- Produces: `encrypt(plain: string, key: Buffer): string` (base64 of iv(12)|tag(16)|ct), `decrypt(blob: string, key: Buffer): string` throws `DecryptError`. `generateGatewayKey(): {plain, hash, prefix}`, `hashGatewayKey(plain): string` (hex SHA-256). `hashPassword(pw): string`, `verifyPassword(pw, stored): boolean` (node `scrypt`, `timingSafeEqual`).

- [ ] **Step 1: Failing tests:** roundtrip; tampered blob throws `DecryptError`; `wrong master key throws DecryptError`; generated key matches `/^gw-[A-Za-z0-9]{40}$/`, `prefix === plain.slice(0,10)`, `hash === hashGatewayKey(plain)`; password verify true/false.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `node:crypto`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: secret encryption and key hashing`.

### Task 3: Repositories

**Files:**
- Create: `server/src/db/repos/{providers,upstreamKeys,models,aliases,gatewayKeys,settings}.ts`, `server/src/db/repos/index.ts`
- Test: `server/test/repos.test.ts`

**Interfaces:**
- Consumes: `Db`, `encrypt/decrypt`.
- Produces: `createRepos(db: Db, masterKey: Buffer): Repos` with per-entity `list/get/create/update/delete`. Plus: `upstreamKeys.createMany(providerId, secrets: string[], defaults)`, `upstreamKeys.getSecret(id): string`, `upstreamKeys.setStatus(id, status, {cooldownUntil?, lastError?})`, `models.upsertSynced(providerId, infos: ModelInfo[])` (keeps manual prices/enabled on existing rows), `gatewayKeys.findByHash(hash)`, `settings.get<T>(k, default)`/`set(k, v)`. Secrets never returned by `list/get` (they expose `secretPreview`: last 4 chars).

- [ ] **Step 1: Failing tests:** `createMany` with 3 secrets → 3 rows, `getSecret` returns plaintext, `list` has no plaintext; `upsertSynced` twice preserves a manually edited `priceInputPerM`; `findByHash` hits/misses; settings default fallback.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: repositories`.

### Task 4: Adapter interface + OpenAI-compatible adapter

**Files:**
- Create: `server/src/adapters/types.ts`, `server/src/adapters/openaiCompat.ts`, `server/src/adapters/registry.ts`, `server/src/adapters/sse.ts`
- Test: `server/test/adapters/openaiCompat.test.ts`, fixtures in `server/test/fixtures/openai/`

**Interfaces:**
- Produces (types.ts):
  ```ts
  type Endpoint = 'chat'|'completions'|'embeddings'|'messages';
  interface Usage { input:number; output:number; cachedRead:number; cacheWrite:number; reasoning:number; estimated:boolean }
  interface ModelInfo { upstreamModelId:string; displayName?:string; contextLength?:number; capabilities?:Capabilities }
  interface UpstreamRequest { url:string; method:'POST'|'GET'; headers:Record<string,string>; body?:string }
  type ErrorClass = 'rate_limited'|'server_error'|'auth_error'|'client_error';
  interface ProviderAdapter {
    supports(e: Endpoint): boolean;
    listModels(p: Provider, key: string, fetchFn: typeof fetch): Promise<ModelInfo[]>;
    buildRequest(e: Endpoint, body: any, upstreamModelId: string, p: Provider, key: string): UpstreamRequest;
    parseResponse(e: Endpoint, json: any): { body: any; usage: Usage|null };
    parseStream(e: Endpoint, events: AsyncIterable<SseEvent>): AsyncIterable<{ chunk?: any; usage?: Usage }>;
    classifyError(status: number): ErrorClass;
  }
  ```
  `sse.ts`: `parseSse(stream: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent>` (`{event?, data}`), `formatSse(data: unknown): string`.
  `registry.ts`: `getAdapter(type: ProviderType): ProviderAdapter`; default base URLs: openai `https://api.openai.com/v1`, openrouter `https://openrouter.ai/api/v1`, groq `https://api.groq.com/openai/v1`, mistral `https://api.mistral.ai/v1`, deepseek `https://api.deepseek.com/v1`, xai `https://api.x.ai/v1`, together `https://api.together.xyz/v1`, ollama `http://127.0.0.1:11434/v1`, anthropic `https://api.anthropic.com/v1`, gemini `https://generativelanguage.googleapis.com/v1beta`.
- OpenAI-compat: Bearer auth, merges `provider.extraHeaders`, replaces `model` with upstreamModelId, for stream chat injects `stream_options:{include_usage:true}`. Usage map: `prompt_tokens→input`, `completion_tokens→output`, `prompt_tokens_details.cached_tokens→cachedRead`, `completion_tokens_details.reasoning_tokens→reasoning`. classifyError: 429→rate_limited, 401/403→auth_error, ≥500 or 408→server_error, else client_error. Does not support `messages`.

- [ ] **Step 1: Failing tests:** buildRequest URL/headers/body (model swapped, include_usage injected only when `stream:true`); parseResponse usage mapping from fixture incl. cached and reasoning; parseStream over fixture SSE yields N chunks and final usage, stops at `[DONE]`; parseSse handles events split across byte chunks and CRLF; classifyError table.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: adapter interface and openai-compatible adapter`.

### Task 5: Anthropic and Gemini adapters

**Files:**
- Create: `server/src/adapters/anthropic.ts`, `server/src/adapters/gemini.ts`; register in `registry.ts`
- Test: `server/test/adapters/anthropic.test.ts`, `server/test/adapters/gemini.test.ts`, fixtures

**Interfaces:**
- Consumes: `ProviderAdapter` types.
- Anthropic: headers `x-api-key`, `anthropic-version: 2023-06-01`. `chat`: OpenAI→Messages (system messages joined into `system`; `image_url` data/http → image block; `tools`/`tool_choice` → Anthropic tools; `tool` role → `tool_result`; `max_tokens` default 4096). Response→OpenAI chat completion (tool_use → `tool_calls`, `stop_reason` map `end_turn→stop, max_tokens→length, tool_use→tool_calls`). Stream: `message_start/content_block_delta/message_delta` → OpenAI chunks. Usage: `input_tokens→input`, `output_tokens→output`, `cache_read_input_tokens→cachedRead`, `cache_creation_input_tokens→cacheWrite`. `messages` endpoint: body passed through (model swapped), stream passed through as-is, usage still extracted. listModels: GET `/models`.
- Gemini: key via `x-goog-api-key` header. `chat` → `:generateContent` / `:streamGenerateContent?alt=sse`; system → `systemInstruction`; roles user/model. `embeddings` → `:embedContent`. Usage: `promptTokenCount→input`, `candidatesTokenCount→output`, `cachedContentTokenCount→cachedRead`, `thoughtsTokenCount→reasoning`. listModels: GET `/models`, strip `models/` prefix, `inputTokenLimit→contextLength`.

- [ ] **Step 1: Failing tests (each adapter):** request translation of a system+user+image+tool conversation matches expected JSON; response with tool call → OpenAI `tool_calls`; stream fixture → text chunks concatenate to expected string + final usage incl. cache fields; listModels parses fixture.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: anthropic and gemini adapters`.

### Task 6: Model resolution & candidate builder

**Files:**
- Create: `server/src/router/resolve.ts`, `server/src/router/candidates.ts`
- Test: `server/test/router/candidates.test.ts`

**Interfaces:**
- Consumes: `Repos` (read-only snapshot).
- Produces: `interface Candidate { provider: Provider; model: Model; key: UpstreamKeyRow; targetWeight: number; targetPriority: number; aliasId: number|null }`. `resolveTargets(requested: string, gk: GatewayKey, snap: ConfigSnapshot): {aliasId, targets: {model, weight, priority}[]}` — alias name first, else `provider-name/upstreamModelId`, else bare upstreamModelId across all providers; filtered by `allowedAliases/allowedModelIds/allowedProviderIds`. `buildCandidates(gk, targets, snap, now: number, limiter: KeyLimiter): Candidate[]` — pool modes: `all`, `explicit` (keyIds), `tags` (any tag matches), `providers` (providerIds); key must belong to target's provider; drop disabled provider/model/alias target, `invalid`/`disabled` keys, `cooldown` with `cooldownUntil > now`, keys over limiter caps. `ConfigSnapshot` = in-memory copy of config tables, `loadSnapshot(repos)`, invalidated on any admin write.
- Errors thrown as `GatewayError(status, type, code, message)` (define in `server/src/errors.ts`): unresolved → 404 `invalid_request_error/model_not_allowed`.

- [ ] **Step 1: Failing tests:** alias with 2 providers × pool of 3 keys each → 6 candidates; `tags` pool `["p3"]` only selects tagged keys; scope excludes provider → filtered; `skips disabled and dangling refs`; cooldown expired key included, active cooldown excluded; unknown model → GatewayError 404.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: model resolution and candidate builder`.

### Task 7: Strategies, limiter, cooldown

**Files:**
- Create: `server/src/router/strategies.ts`, `server/src/router/limiter.ts`, `server/src/router/cooldown.ts`
- Test: `server/test/router/strategies.test.ts`, `limiter.test.ts`, `cooldown.test.ts`

**Interfaces:**
- Produces: `orderCandidates(strategy, gkId: number, cands: Candidate[], state: RouterState, rand = Math.random): Candidate[]` (full ordered list; first = primary, rest = failover order). `RouterState { rrCursor: Map<number, number>; recentUse: (keyId)=>number }`. Round-robin: stable sort cands by `(provider.id, key.id, model.id)`, start index `cursor % n`, rotate, then `cursor++`. Weighted: weighted shuffle by `key.weight*targetWeight`. least_used: ascending `recentUse` (60s window). priority_failover: group by `targetPriority` asc, RR within group.
- `KeyLimiter` (sliding 60s windows, in memory): `check(kind:'gw'|'up', id, limits:{rpm?,tpm?}): boolean`, `record(kind, id, tokens)`, `countLast60s(kind,id)`. Daily caps checked via `dailyCounts(keyId)` from rollups (passed in).
- `nextCooldown(errorClass, attemptsInRow: number, retryAfterHeader?: string, now): {status, cooldownUntil?}`: rate_limited → Retry-After (seconds or HTTP date) else `30s*2^(n-1)` ≤ 15m; server_error → 15s; auth_error → `invalid`.

- [ ] **Step 1: Failing tests:** RR over 4 candidates for 8 calls hits each exactly twice and in rotation; RR cursors independent per gateway key; weighted with rand stub picks expected; priority_failover tier 1 before tier 2; limiter rpm=2 blocks third call within 60s and allows after fake-time advance; cooldown table incl. Retry-After `"7"` → 7000ms and cap at 15m; `all keys unavailable` (empty cands) handled by Task 9 — here assert `orderCandidates` returns `[]`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (use `vi.useFakeTimers` in tests). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: routing strategies, limiter and cooldowns`.

### Task 8: Usage, cost and async log writer with rollups

**Files:**
- Create: `server/src/logging/usage.ts`, `server/src/logging/logWriter.ts`, `server/src/logging/retention.ts`
- Test: `server/test/logging.test.ts`

**Interfaces:**
- Produces: `estimateUsage(requestBody, outputText): Usage` (gpt-tokenizer, `estimated:true`). `computeCost(u: Usage, m: Model): number` = `((input-cachedRead)*in + cachedRead*(cachedReadPrice ?? in) + cacheWrite*(cacheWritePrice ?? in) + output*out)/1e6` (null prices → 0). `class LogWriter { enqueue(log: NewRequestLog, attempts: NewAttempt[]): void; flush(): void; start(): void; stop(): Promise<void> }` — flush on 1s timer or 200 queued, one transaction inserting logs/attempts and upserting `hour` and `day` rollups (bucketStart = UTC floor). Flush failure logs error and requeues once, never throws. `pruneLogs(db, retentionDays, now)` deletes `requestLogs`/attempts older than cutoff.

- [ ] **Step 1: Failing tests:** cost with cached tokens; `estimates usage when missing` (non-zero input/output, estimated true); enqueue 3 logs same hour → after flush one hour rollup with summed tokens and requests=3, errors counted; 200th enqueue triggers sync flush; prune removes old rows, keeps rollups.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: usage, cost, batched logging and rollups`.

### Task 9: Proxy pipeline & /v1 routes

**Files:**
- Create: `server/src/proxy/auth.ts`, `server/src/proxy/pipeline.ts`, `server/src/proxy/routes.ts`, `server/src/errors.ts` (if not yet), `server/src/app.ts` (`buildApp(deps): FastifyInstance`)
- Test: `server/test/proxy.test.ts` with `server/test/helpers/mockUpstream.ts` (Fastify mock provider: configurable status sequence, JSON or SSE replies)

**Interfaces:**
- Consumes: Tasks 3–8.
- Produces: `buildApp({db, repos, env, logWriter, fetchFn?}): FastifyInstance`. Routes: `POST /v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/messages`, `GET /v1/models` (OpenAI list shape, scoped to key: aliases + direct `provider/model` ids). `authenticate(req): GatewayKey` (Bearer or `x-api-key`; checks enabled, `expiresAt`, `ipAllowlist`, rpm/tpm, daily/monthly budget, token quota → 401 `invalid_api_key` / 403 `ip_not_allowed` / 429 `gateway_limit` / 402 `budget_exceeded`).
- Pipeline `handle(endpoint, req, reply)`: apply `defaultParams` (only missing fields), `paramOverrides` (forced), `maxTokensCap` (min); resolve → candidates → order → attempt loop up to `maxRetries+1` over the ordered list (each candidate at most once). Per attempt: decrypt secret (on `DecryptError` → key `invalid`, `lastError:"decrypt_failed"`, next); undici request with provider `timeoutMs` and an `AbortController` tied to client close. Non-2xx before body streamed → classify, apply cooldown, record attempt, next (client_error → return upstream error immediately, wrapped in standard error body with `type:"upstream_error"`, original status). Streaming: write SSE headers only after first upstream chunk arrives; after that, failure → write error chunk + `[DONE]`, end. Empty/exhausted list → 503 `no_available_upstream` (message includes soonest `cooldownUntil` ISO if any). Always enqueue a RequestLog (incl. `attempts`, `ttftMs`, `client_aborted`).

- [ ] **Step 1: Failing tests (against mock upstream):** non-stream success returns OpenAI body, log row has tokens & cost; stream success relays chunks, final usage logged; 3 calls with 3 keys hit 3 distinct keys (`Authorization` seen by mock); first key 429 with `Retry-After: 5` → served by second, first key status cooldown ~5s; 401 → key `invalid`; 400 → returned, no retry; `all keys unavailable` → 503 `no_available_upstream`; `aborts upstream on client disconnect`; `decrypt failure marks key invalid`; wrong gateway key → 401 standard error body; `/v1/models` lists only scoped models; `defaultParams`/`paramOverrides` visible in mock-received body.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: proxy pipeline with rotation and failover`.

### Task 10: Admin API

**Files:**
- Create: `server/src/admin/session.ts`, `server/src/admin/routes/{auth,providers,upstreamKeys,models,aliases,gatewayKeys,logs,analytics,settings}.ts`, `server/src/admin/schemas.ts` (zod)
- Test: `server/test/admin.test.ts`

**Interfaces:**
- Consumes: Repos, snapshot invalidation, `getAdapter().listModels`.
- Produces (all under `/admin/api`, JSON, zod-validated, 401 without session except `auth/*`):
  - `GET auth/status` → `{setupRequired, authenticated}`; `POST auth/setup {password}` (only when none set; min 8 chars); `POST auth/login` (5 failures/min/IP → 429); `POST auth/logout`. Session: random 32-byte token in memory map, httpOnly SameSite=Strict cookie, 7-day expiry.
  - CRUD `providers`, `POST providers/:id/test`, `POST providers/:id/sync-models` → `{added, updated}` (uses first active key).
  - CRUD `upstream-keys`, `POST upstream-keys/bulk {providerId, secrets: string (newline separated), tags, weight}`, `POST upstream-keys/:id/test`, `POST upstream-keys/:id/reset` (status→active).
  - CRUD `models`, CRUD `aliases` with nested `targets`.
  - CRUD `gateway-keys` (create returns `{...row, key: plain}`), `POST gateway-keys/:id/regenerate`.
  - `GET logs?from&to&gatewayKeyId&providerId&modelId&upstreamKeyId&status&q&cursor&limit` (keyset pagination by id desc, limit ≤ 200), `GET logs/:id` (with attempts).
  - `GET analytics/summary?from&to` (totals + p50/p95 latency from raw logs), `GET analytics/timeseries?from&to&metric&groupBy` (`groupBy ∈ none|gatewayKey|upstreamKey|provider|model`, bucket auto hour ≤7d else day), `GET analytics/top?dimension&metric&from&to&limit`, `GET analytics/export.csv?...`, `GET alerts` (invalid keys, active cooldowns, budgets ≥80%).
  - `GET/PUT settings`, `GET settings/backup` (streams `VACUUM INTO` temp copy), `POST settings/restore` (upload db, validate schema, swap on restart flag), `GET config/export` (JSON without secrets unless `?includeSecrets=1`, which exports decrypted), `POST config/import`.

- [ ] **Step 1: Failing tests:** setup→login→protected route ok; unauthenticated 401; invalid body 400 with zod message in standard error shape; bulk keys with 3 lines (blank lines ignored, duplicates rejected per provider) → 3 created; sync-models against mock upstream → models inserted; gateway key create returns plain once, `GET` never does; timeseries groupBy provider returns series per provider from seeded logs; export.csv header row; config export→import roundtrip.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: admin API`.

### Task 11: Server bootstrap, robustness & static serving

**Files:**
- Create: `server/src/index.ts`, `scripts/install-service.cjs` (node-windows install/uninstall)
- Modify: `server/src/app.ts` (global error handler, 404 handler, `@fastify/static` for `web/dist` with SPA fallback, `bodyLimit` 20 MB, `GET /health`)
- Test: `server/test/app.test.ts`

**Interfaces:**
- Produces: `npm start` runs `node server/dist/index.js`. `/health` → `{status:"ok", db:true, uptimeS}`. Global handler maps `GatewayError` and zod errors to standard body; unknown → 500 `internal_error` (message generic, details in pino log). `process.on('unhandledRejection'|'uncaughtException')` log and continue. SIGINT/SIGTERM: `app.close()` (drain ≤30s), `logWriter.stop()`, persist RR cursors, `db.close()`. Daily retention timer + RR cursor persistence timer.

- [ ] **Step 1: Failing tests:** `/health` ok; route throwing a plain Error → 500 standard body, server still answers next request; unknown `/v1/foo` → 404 standard body; unknown non-API path serves `index.html` when present.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: bootstrap, error handling and static serving`.

### Task 12: Dashboard shell, auth and API client

**Files:**
- Create: `web/` (Vite React TS), `web/tailwind.config.ts`, `web/src/main.tsx`, `web/src/App.tsx` (router), `web/src/lib/api.ts`, `web/src/components/ui/*` (shadcn: button, input, dialog, table, select, badge, card, tabs, toast, dropdown, switch, sheet), `web/src/components/Layout.tsx` (sidebar nav, theme toggle), `web/src/pages/Login.tsx`, `web/src/pages/Setup.tsx`
- Modify: `web/vite.config.ts` (dev proxy `/admin` and `/v1` → `127.0.0.1:8787`)

**Interfaces:**
- Produces: `api<T>(path, init?)` (prefixes `/admin/api`, credentials include, throws `ApiError{status, code, message}` from standard error body; 401 → redirect to `/login`). Query hooks per resource in `web/src/lib/queries.ts` named `useProviders`, `useUpstreamKeys`, `useModels`, `useAliases`, `useGatewayKeys`, `useLogs`, `useSummary`, `useTimeseries`, `useTop`, `useAlerts`, `useSettings` and matching mutations that invalidate their list. Sidebar routes: `/`, `/providers`, `/keys`, `/models`, `/gateway-keys`, `/logs`, `/analytics`, `/settings`. Theme stored in localStorage (try/catch), default system.

- [ ] **Step 1:** Build shell, login/setup flow; errors shown as toasts.
- [ ] **Step 2:** Verify: `npm run build -w web` succeeds; with server running, setup → login → sidebar visible (manual check in browser pane).
- [ ] **Step 3:** Commit `feat: dashboard shell and auth`.

### Task 13: Providers, Upstream Keys, Models & Aliases pages

**Files:**
- Create: `web/src/pages/Providers.tsx`, `ProviderDetail.tsx`, `UpstreamKeys.tsx`, `Models.tsx`, `Aliases.tsx`, `web/src/components/forms/{ProviderForm,BulkKeysDialog,AliasBuilder}.tsx`

**Interfaces:**
- Consumes: Task 12 hooks; Task 10 endpoints.
- Providers: table (name, type, base URL, enabled switch, key count, 24h requests), add/edit dialog (type select prefills base URL), Test and Sync Models buttons with result toast. Upstream Keys: filter by provider/tag/status, columns label, preview `••••abcd`, tags, weight, status badge with live cooldown countdown, last error, 24h requests/tokens; bulk paste dialog; row actions test/reset/disable/delete (confirm dialog). Models: filterable catalog with inline price editing and enabled switch. Aliases: builder — name, then add targets (provider → model select), weight & priority per target.

- [ ] **Step 1:** Implement pages.
- [ ] **Step 2:** Verify in browser pane against a mock/real provider: create provider, bulk add 3 keys, sync models, build alias with two targets. `npm run build -w web` passes with no TS errors.
- [ ] **Step 3:** Commit `feat: provider, key, model and alias management UI`.

### Task 14: Gateway Keys page

**Files:**
- Create: `web/src/pages/GatewayKeys.tsx`, `web/src/pages/GatewayKeyDetail.tsx`, `web/src/components/forms/GatewayKeyWizard.tsx`

**Interfaces:**
- Wizard steps: Basics (name, expiry, enabled) → Scope (aliases/models/providers multi-selects, "all" toggles) → Key Pool (mode radio: all/explicit/tags/providers with the matching picker and a live "N keys match" count) → Routing (strategy, maxRetries) → Limits (rpm, tpm, daily/monthly USD budget, token quota, maxTokensCap, IP allowlist) → Advanced (defaultParams/paramOverrides JSON editors validated client-side, logBodies). Create shows the key once with copy button and a ready `curl` / OpenAI SDK snippet using `http://127.0.0.1:8787/v1`. Detail page: config summary, edit (same wizard), regenerate, revoke, usage charts filtered to the key, budget progress bars.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Verify in browser pane: create key with tag pool, copy key, run the curl snippet against a mock upstream, request appears in detail usage.
- [ ] **Step 3:** Commit `feat: gateway key wizard and detail`.

### Task 15: Overview, Logs, Analytics, Settings pages

**Files:**
- Create: `web/src/pages/Overview.tsx`, `Logs.tsx`, `Analytics.tsx`, `Settings.tsx`, `web/src/components/charts/{TimeSeriesChart,TopList,KpiTile}.tsx`, `web/src/components/TimeRangePicker.tsx`, `web/src/components/LogDrawer.tsx`

**Interfaces:**
- Overview: range picker (24h/7d/30d/custom), KPI tiles (requests, input, output, cached tokens, cost, error rate, p50/p95 latency), requests+tokens time series, top models/gateway keys/upstream keys, alerts list; auto-refresh 15s.
- Logs: filters (range, key, provider, model, upstream key, status, text), infinite scroll via cursor, drawer with routing attempts table, tokens/cost, bodies if stored.
- Analytics: metric select (requests, errors, input, output, cachedRead, cacheWrite, reasoning, cost, avgLatency, cacheHitRatio) × groupBy × range; stacked chart + table; CSV export link.
- Settings: change password, retention days, default cooldowns/maxRetries, backup download, restore upload, config export/import.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Verify in browser pane with seeded traffic (script `server/scripts/seed-demo.ts` generating ~2k fake logs across 3 providers): charts render in light and dark, filters change results, CSV downloads.
- [ ] **Step 3:** Commit `feat: overview, logs, analytics and settings UI`.

### Task 16: E2E smoke, README and Windows run scripts

**Files:**
- Create: `e2e/smoke.spec.ts`, `playwright.config.ts`, `README.md`, `start-gateway.bat`

**Interfaces:**
- Smoke: start server with temp data dir + mock upstream; setup password → add custom_openai provider pointing at mock → bulk add 2 keys → sync models → create gateway key (pool all) → call `/v1/chat/completions` twice via fetch → Logs page shows 2 rows with different upstream keys.
- README: install, first run, master key backup warning, using with OpenAI SDK, Windows service install, backup/restore.

- [ ] **Step 1:** Write smoke test; run `npx playwright test` → PASS.
- [ ] **Step 2:** Full suite `npm test` → all PASS; `npm run build` → success.
- [ ] **Step 3:** Commit `test: e2e smoke; docs: README and run scripts`.
