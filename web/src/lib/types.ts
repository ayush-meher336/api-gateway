export const PROVIDER_TYPES = [
  'openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral', 'deepseek', 'xai', 'together', 'ollama', 'custom_openai',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_LABELS: Record<ProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  together: 'Together',
  ollama: 'Ollama (local)',
  custom_openai: 'Custom (OpenAI-compatible)',
};

export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  xai: 'https://api.x.ai/v1',
  together: 'https://api.together.xyz/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  custom_openai: '',
};

export const STRATEGIES = ['round_robin', 'weighted', 'least_used', 'random', 'priority_failover'] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const STRATEGY_INFO: Record<Strategy, { label: string; help: string }> = {
  round_robin: { label: 'Round robin', help: 'Every call moves to the next key in turn. Spreads usage evenly.' },
  weighted: { label: 'Weighted', help: 'Picks keys at random in proportion to key weight × target weight.' },
  least_used: { label: 'Least used', help: 'Picks the key with the fewest requests in the last minute.' },
  random: { label: 'Random', help: 'Uniformly random key each call.' },
  priority_failover: { label: 'Priority failover', help: 'Uses priority 0 targets first, falling back to higher numbers only on failure.' },
};

export interface Stats {
  requests: number;
  errors: number;
  tokens: number;
  costUsd: number;
}

export interface Provider {
  id: number;
  name: string;
  type: ProviderType;
  baseUrl: string;
  extraHeaders: Record<string, string>;
  timeoutMs: number;
  enabled: boolean;
  priority: number;
  createdAt: number;
  keyCount: number;
  activeKeyCount: number;
  modelCount: number;
  last24h: Stats;
}

export type KeyStatus = 'active' | 'cooldown' | 'disabled' | 'invalid';

export interface UpstreamKey {
  id: number;
  providerId: number;
  label: string;
  secretPreview: string;
  tags: string[];
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  dailyRequestCap: number | null;
  dailyTokenCap: number | null;
  status: KeyStatus;
  cooldownUntil: number | null;
  failStreak: number;
  lastError: string | null;
  lastUsedAt: number | null;
  createdAt: number;
  last24h: Stats;
}

export interface Model {
  id: number;
  providerId: number;
  upstreamModelId: string;
  displayName: string | null;
  contextLength: number | null;
  capabilities: Record<string, boolean>;
  priceInputPerM: number | null;
  priceOutputPerM: number | null;
  priceCachedReadPerM: number | null;
  priceCacheWritePerM: number | null;
  source: 'synced' | 'manual';
  enabled: boolean;
  last24h: Stats;
}

export interface AliasTarget {
  id?: number;
  modelId: number;
  weight: number;
  priority: number;
  enabled: boolean;
}

export interface Alias {
  id: number;
  name: string;
  description: string | null;
  enabled: boolean;
  targets: AliasTarget[];
}

export type KeyPool =
  | { mode: 'all' }
  | { mode: 'explicit'; keyIds: number[] }
  | { mode: 'tags'; tags: string[] }
  | { mode: 'providers'; providerIds: number[] };

export interface GatewayKey {
  id: number;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  expiresAt: number | null;
  allowedAliases: string[] | null;
  allowedModelIds: number[] | null;
  allowedProviderIds: number[] | null;
  pool: KeyPool;
  strategy: Strategy;
  maxRetries: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  budgetDailyUsd: number | null;
  budgetMonthlyUsd: number | null;
  tokenQuotaTotal: number | null;
  ipAllowlist: string[];
  defaultParams: Record<string, unknown>;
  paramOverrides: Record<string, unknown>;
  maxTokensCap: number | null;
  logBodies: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  last24h: Stats;
  spend: { dayUsd: number; monthUsd: number; totalTokens: number };
  key?: string;
}

export interface LogRow {
  id: number;
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
}

export interface LogDetail extends LogRow {
  requestBody: string | null;
  responseBody: string | null;
  attempts: any;
}

export interface Attempt {
  n: number;
  providerId: number | null;
  upstreamKeyId: number | null;
  modelId: number | null;
  httpStatus: number | null;
  errorType: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
}

export interface Summary {
  from: number;
  to: number;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  totalTokens: number;
  avgLatencyMs: number;
  cacheHitRatio: number;
  errorRate: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
}

export type GroupBy = 'none' | 'gatewayKey' | 'upstreamKey' | 'provider' | 'model';
export type Metric =
  | 'requests' | 'errors' | 'inputTokens' | 'outputTokens' | 'cachedReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'
  | 'totalTokens' | 'costUsd' | 'avgLatencyMs' | 'cacheHitRatio' | 'errorRate';

export const METRIC_LABELS: Record<Metric, string> = {
  requests: 'Requests',
  errors: 'Errors',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cachedReadTokens: 'Cached tokens',
  cacheWriteTokens: 'Cache write tokens',
  reasoningTokens: 'Reasoning tokens',
  totalTokens: 'Total tokens',
  costUsd: 'Cost (USD)',
  avgLatencyMs: 'Avg latency (ms)',
  cacheHitRatio: 'Cache hit ratio',
  errorRate: 'Error rate',
};

export const GROUP_LABELS: Record<GroupBy, string> = {
  none: 'Total',
  gatewayKey: 'Gateway key',
  upstreamKey: 'Upstream key',
  provider: 'Provider',
  model: 'Model',
};

export interface Timeseries {
  bucket: 'hour' | 'day';
  from: number;
  to: number;
  buckets: number[];
  series: { key: string; label: string; points: { t: number; v: number }[] }[];
}

export interface TopRow {
  key: string;
  label: string;
  value: number;
  requests: number;
}

export interface Alert {
  kind: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  ref: { type: string; id: number };
}

export interface Settings {
  retentionDays: number;
  rateLimitCooldownMs: number;
  serverErrorCooldownMs: number;
  maxCooldownMs: number;
  defaultMaxRetries: number;
  defaultProviderTimeoutMs: number;
}
