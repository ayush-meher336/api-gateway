import { z } from 'zod';
import { PROVIDER_TYPES, STRATEGIES } from '../db/types.js';

const nullablePositiveInt = z.number().int().positive().nullable();
const nullablePositive = z.number().positive().nullable();
const idList = z.array(z.number().int().positive());

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const providerCreate = z.object({
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'use letters, digits, dot, dash or underscore'),
  type: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().trim().url().optional(),
  extraHeaders: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});
export const providerUpdate = providerCreate.partial();

const keyLimits = {
  weight: z.number().min(0).max(1000).optional(),
  rpmLimit: nullablePositiveInt.optional(),
  tpmLimit: nullablePositiveInt.optional(),
  dailyRequestCap: nullablePositiveInt.optional(),
  dailyTokenCap: nullablePositiveInt.optional(),
};

export const upstreamKeysBulk = z.object({
  providerId: z.number().int().positive(),
  secrets: z.union([z.string(), z.array(z.string())]),
  label: z.string().max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).optional(),
  ...keyLimits,
});

export const upstreamKeyUpdate = z.object({
  label: z.string().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  ...keyLimits,
});

const price = z.number().min(0).nullable().optional();
export const modelCreate = z.object({
  providerId: z.number().int().positive(),
  upstreamModelId: z.string().trim().min(1).max(300),
  displayName: z.string().max(200).nullable().optional(),
  contextLength: nullablePositiveInt.optional(),
  capabilities: z.record(z.boolean()).optional(),
  priceInputPerM: price,
  priceOutputPerM: price,
  priceCachedReadPerM: price,
  priceCacheWritePerM: price,
  enabled: z.boolean().optional(),
});
export const modelUpdate = modelCreate.omit({ providerId: true, upstreamModelId: true }).partial();

const target = z.object({
  modelId: z.number().int().positive(),
  weight: z.number().min(0).max(1000).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  enabled: z.boolean().optional(),
});
export const aliasCreate = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  targets: z.array(target).max(200).default([]),
});
export const aliasUpdate = aliasCreate.partial();

export const pool = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('explicit'), keyIds: idList }),
  z.object({ mode: z.literal('tags'), tags: z.array(z.string().min(1)).min(1) }),
  z.object({ mode: z.literal('providers'), providerIds: idList.min(1) }),
]);

export const gatewayKeyCreate = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  allowedAliases: z.array(z.string()).nullable().optional(),
  // null = all; an empty list would block every request, so require at least one
  allowedModelIds: idList.min(1, 'select at least one model, or allow all').nullable().optional(),
  allowedProviderIds: idList.min(1, 'select at least one provider, or allow all').nullable().optional(),
  pool: pool.optional(),
  strategy: z.enum(STRATEGIES).optional(),
  maxRetries: z.number().int().min(0).max(20).optional(),
  rpmLimit: nullablePositiveInt.optional(),
  tpmLimit: nullablePositiveInt.optional(),
  budgetDailyUsd: nullablePositive.optional(),
  budgetMonthlyUsd: nullablePositive.optional(),
  tokenQuotaTotal: nullablePositiveInt.optional(),
  ipAllowlist: z.array(z.string().trim().min(1)).optional(),
  defaultParams: z.record(z.unknown()).optional(),
  paramOverrides: z.record(z.unknown()).optional(),
  maxTokensCap: nullablePositiveInt.optional(),
  logBodies: z.boolean().optional(),
});
export const gatewayKeyUpdate = gatewayKeyCreate.partial();

export const settingsUpdate = z
  .object({
    retentionDays: z.number().int().min(1).max(3650),
    rateLimitCooldownMs: z.number().int().min(1000).max(3_600_000),
    serverErrorCooldownMs: z.number().int().min(0).max(3_600_000),
    maxCooldownMs: z.number().int().min(1000).max(86_400_000),
    defaultMaxRetries: z.number().int().min(0).max(20),
    defaultProviderTimeoutMs: z.number().int().min(1000).max(3_600_000),
  })
  .partial();

export const passwordBody = z.object({ password: z.string().min(8).max(200) });
export const changePassword = z.object({ current: z.string(), next: z.string().min(8).max(200) });

const ts = z.coerce.number().int().nonnegative();
export const rangeQuery = z.object({ from: ts.optional(), to: ts.optional() });
export const groupBy = z.enum(['none', 'gatewayKey', 'upstreamKey', 'provider', 'model']);
export const metric = z.enum([
  'requests', 'errors', 'inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheWriteTokens', 'reasoningTokens',
  'totalTokens', 'costUsd', 'avgLatencyMs', 'cacheHitRatio', 'errorRate',
]);

export const logsQuery = z.object({
  from: ts.optional(),
  to: ts.optional(),
  gatewayKeyId: z.coerce.number().int().optional(),
  providerId: z.coerce.number().int().optional(),
  modelId: z.coerce.number().int().optional(),
  upstreamKeyId: z.coerce.number().int().optional(),
  status: z.enum(['ok', 'error']).optional(),
  q: z.string().max(200).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
