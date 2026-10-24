export const PROVIDER_TYPES = [
  'openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral',
  'deepseek', 'xai', 'together', 'ollama', 'custom_openai',
] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const STRATEGIES = ['round_robin', 'weighted', 'least_used', 'random', 'priority_failover'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type KeyStatus = 'active' | 'cooldown' | 'disabled' | 'invalid';

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
}

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
}

export interface Capabilities {
  chat?: boolean;
  vision?: boolean;
  tools?: boolean;
  embeddings?: boolean;
  reasoning?: boolean;
}

export interface Model {
  id: number;
  providerId: number;
  upstreamModelId: string;
  displayName: string | null;
  contextLength: number | null;
  capabilities: Capabilities;
  priceInputPerM: number | null;
  priceOutputPerM: number | null;
  priceCachedReadPerM: number | null;
  priceCacheWritePerM: number | null;
  source: 'synced' | 'manual';
  enabled: boolean;
}

export interface AliasTarget {
  id: number;
  aliasId: number;
  modelId: number;
  weight: number;
  priority: number;
  enabled: boolean;
}

export interface ModelAlias {
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
}
