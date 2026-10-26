# AI Gateway

A self-hosted gateway that pools many AI provider API keys behind your own gateway keys. Every call rotates across the upstream keys (and providers) a gateway key is allowed to use, with automatic failover, cooldowns, budgets and full usage analytics in a web dashboard.

- **Providers:** OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Ollama, plus any OpenAI-compatible endpoint.
- **One API for your apps:** OpenAI-compatible `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`, plus the Anthropic-native `/v1/messages`. Anthropic and Gemini are translated automatically, including streaming, tools and images.
- **Runs locally:** one Node process, one SQLite file, bound to `127.0.0.1:8787`.

## Requirements

- Windows, macOS or Linux
- Node.js **22.5 or newer** (it uses the built-in `node:sqlite`)

## Install and run

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

On Windows you can double-click `start-gateway.bat` instead. It installs, builds and starts the gateway, then opens the dashboard.

Open **http://127.0.0.1:8787** and set your admin password.

On first start the gateway writes a `.env` file containing `GATEWAY_MASTER_KEY`. That key encrypts every provider API key in the database.

> **Back up `.env`.** Without the master key, the stored provider keys (and any database backups) cannot be decrypted.

## Setting it up

1. **Providers → Add provider.** Pick the type; the base URL is filled in for you.
2. **Keys** (on the provider row, or the Upstream keys page). Paste as many API keys as you like, one per line. Tag them (`free`, `p3`, `batch`…) if you want to build pools from tags later.
3. **Sync models.** This fetches the provider's model list. Set prices on the Models page if you want cost tracking and budgets.
4. **Aliases (optional).** Give one public name several targets, for example `gpt-4o` → `openai/gpt-4o` and `openrouter/openai/gpt-4o`. Calls to `gpt-4o` then rotate across both providers' keys.
5. **Gateway keys → Create key.** Choose:
   - **Access:** which aliases, models and providers the key may use.
   - **Key pool:** all keys, keys of specific providers, keys with given tags, or hand-picked keys (for example "5 of the 10 keys from provider 3").
   - **Routing:** `round_robin` (default; every call goes to the next key), `weighted`, `least_used`, `random`, or `priority_failover`.
   - **Limits:** requests/min, tokens/min, daily and monthly USD budget, lifetime token quota, max output tokens, IP allowlist, expiry.
   - **Advanced:** default parameters, forced overrides, and full request/response logging.

The key is shown once. Copy it.

## Using it from your apps

Point any OpenAI SDK at the gateway:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="gw-...")
client.chat.completions.create(model="gpt-4o", messages=[{"role": "user", "content": "Hello"}])
```

The `model` field can be:

- **An alias name**, such as `gpt-4o` or `fast`.
- **`provider-name/model-id`**, such as `openrouter/meta-llama/llama-3.3-70b-instruct`.
- **A bare model id.** It is served by every provider that has that model.

`GET /v1/models` lists exactly what that key may call.

The Anthropic SDK works against `/v1/messages`. Set its base URL to `http://127.0.0.1:8787` and pass the gateway key as the API key.

## How routing and failover work

For each request the gateway:

1. **Checks the gateway key:** enabled, not expired, IP allowed, under its rate limits and budgets.
2. **Resolves the model** to its targets, filtered by the key's access rules.
3. **Builds the candidate list.** It pairs every target with every pool key on that target's provider, skipping keys that are disabled, invalid, cooling down, or over their own per-minute or per-day limits.
4. **Orders the candidates** using the key's strategy. Round-robin keeps a cursor per gateway key, so consecutive calls really do spread across keys.
5. **Tries candidates in order,** up to `maxRetries + 1` attempts:

| Upstream result | What happens |
|---|---|
| 429 rate limit | That key skips **only that model** for `Retry-After` or 15s; its status is untouched. If a second key is refused for the same model within 10s, the model is treated as busy on that provider and skipped for ~10s, so the request fails over to the next provider. If every option is rate limiting, the client gets 429 |
| 5xx, network error, timeout | The key cools down for 15s and the gateway tries the next key |
| 401 / 403 | The key is marked **invalid** (it shows in Alerts) and the gateway tries the next key |
| 400 / 404 / 422 (your request) | The error is returned as-is, without retry |
| Failure mid-stream | The stream ends with an error event; no retry is possible once data has been sent |

When nothing is available you get `503 no_available_upstream`, with the time the next key frees up. Every attempt is recorded and visible in the log drawer.

All gateway errors use one shape: `{"error": {"type", "code", "message"}}`.

## Analytics

The dashboard tracks requests, errors, input / output / cached / cache-write / reasoning tokens, cost and latency (p50/p95/p99). You can break any metric down by gateway key, upstream key, provider or model, over any time range, and export it as CSV.

- **Retention:** raw request logs are kept for 90 days (configurable); hourly and daily totals are kept forever.
- **Usage counts:** when a provider reports no usage (some streams, Ollama), tokens are estimated and marked with `*`.

## Backups

**Settings → Backup & transfer:**

- **Download backup:** a full copy of the SQLite database.
- **Restore backup:** staged by the dashboard and applied on the next start. The old database is kept as `gateway.db.bak-<time>`.
- **Export / import config (JSON):** providers, models, prices, aliases, gateway keys and settings. Import merges by name, so running it twice is safe. "Include secrets" puts provider keys in the file **in plain text**.

## Run as a Windows service

From an Administrator terminal:

```bash
npm install -g node-windows
```

```bash
npm link node-windows
```

```bash
npm run service:install
```

Remove it with `npm run service:uninstall`.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `HOST` | `127.0.0.1` | Use `0.0.0.0` only if other machines must reach it, and put it behind TLS |
| `PORT` | `8787` | |
| `DATA_DIR` | `./data` | Database location |
| `LOG_LEVEL` | `info` | |
| `GATEWAY_MASTER_KEY` | generated | 64 hex chars. **Never lose or change it** |

Cooldowns, retries, timeouts and retention are tunable on the Settings page.

## Development

```bash
npm run dev -w server
```

```bash
npm run dev -w web
```

```bash
npm test
```

The web dev server runs on :5173 and proxies to the gateway on :8787. The tests are unit tests, mock-provider integration tests, and a full-stack end-to-end test.

To try the dashboard with fake data, run the seed script against a **scratch** data directory:

```bash
DATA_DIR=./demo-data GATEWAY_ENV_FILE=./demo.env npx tsx server/scripts/seed-demo.ts
```

### Layout

```
server/src/
  adapters/   provider translation (OpenAI-compatible, Anthropic, Gemini)
  router/     model resolution, candidates, strategies, limits, cooldowns
  proxy/      /v1 auth and request pipeline
  logging/    usage, cost, batched log writer, rollups, retention
  admin/      dashboard API
  db/         schema, migrations, repositories
web/src/      React dashboard
```
