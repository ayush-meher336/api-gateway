// Ordered migrations. Never edit a released entry; append a new one.
export const migrations: string[] = [
  `
CREATE TABLE providers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  base_url TEXT NOT NULL,
  extra_headers TEXT NOT NULL DEFAULT '{}',
  timeout_ms INTEGER NOT NULL DEFAULT 120000,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE upstream_keys (
  id INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  secret_hash TEXT NOT NULL DEFAULT '',
  secret_preview TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  weight REAL NOT NULL DEFAULT 1,
  rpm_limit INTEGER, tpm_limit INTEGER, daily_request_cap INTEGER, daily_token_cap INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  cooldown_until INTEGER,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX upstream_keys_provider ON upstream_keys(provider_id);
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  upstream_model_id TEXT NOT NULL,
  display_name TEXT,
  context_length INTEGER,
  capabilities TEXT NOT NULL DEFAULT '{}',
  price_input_per_m REAL, price_output_per_m REAL, price_cached_read_per_m REAL, price_cache_write_per_m REAL,
  source TEXT NOT NULL DEFAULT 'manual',
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(provider_id, upstream_model_id)
);
CREATE TABLE model_aliases (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE alias_targets (
  id INTEGER PRIMARY KEY,
  alias_id INTEGER NOT NULL REFERENCES model_aliases(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE gateway_keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  allowed_aliases TEXT, allowed_model_ids TEXT, allowed_provider_ids TEXT,
  pool TEXT NOT NULL DEFAULT '{"mode":"all"}',
  strategy TEXT NOT NULL DEFAULT 'round_robin',
  max_retries INTEGER NOT NULL DEFAULT 3,
  rpm_limit INTEGER, tpm_limit INTEGER,
  budget_daily_usd REAL, budget_monthly_usd REAL, token_quota_total INTEGER,
  ip_allowlist TEXT NOT NULL DEFAULT '[]',
  default_params TEXT NOT NULL DEFAULT '{}',
  param_overrides TEXT NOT NULL DEFAULT '{}',
  max_tokens_cap INTEGER,
  log_bodies INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  gateway_key_id INTEGER,
  requested_model TEXT,
  alias_id INTEGER, provider_id INTEGER, model_id INTEGER, upstream_key_id INTEGER,
  endpoint TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  http_status INTEGER,
  error_type TEXT, error_message TEXT,
  latency_ms INTEGER, ttft_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  usage_estimated INTEGER NOT NULL DEFAULT 0,
  client_ip TEXT,
  request_body TEXT, response_body TEXT
);
CREATE INDEX request_logs_ts ON request_logs(ts);
CREATE INDEX request_logs_gk_ts ON request_logs(gateway_key_id, ts);
CREATE TABLE request_attempts (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES request_logs(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  provider_id INTEGER, upstream_key_id INTEGER, model_id INTEGER,
  http_status INTEGER, error_type TEXT, error_message TEXT, latency_ms INTEGER
);
CREATE INDEX request_attempts_req ON request_attempts(request_id);
CREATE TABLE usage_rollups (
  bucket TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  gateway_key_id INTEGER NOT NULL DEFAULT 0,
  upstream_key_id INTEGER NOT NULL DEFAULT 0,
  provider_id INTEGER NOT NULL DEFAULT 0,
  model_id INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  latency_sum_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, bucket_start, gateway_key_id, upstream_key_id, provider_id, model_id)
);
CREATE INDEX usage_rollups_start ON usage_rollups(bucket, bucket_start);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
];
