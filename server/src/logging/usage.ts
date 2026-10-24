import { encode } from 'gpt-tokenizer';
import type { Usage } from '../adapters/types.js';
import type { Model } from '../db/types.js';

function count(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textOf).join('\n');
  if (typeof v === 'object') {
    const o = v as any;
    if (typeof o.text === 'string') return o.text;
    if (o.content !== undefined) return textOf(o.content);
    return '';
  }
  return String(v);
}

/** Tokenizer-based estimate for providers that report no usage. */
export function estimateUsage(requestBody: any, outputText: string): Usage {
  const b = requestBody ?? {};
  const promptText = [textOf(b.system), textOf(b.messages), textOf(b.prompt), textOf(b.input)].filter(Boolean).join('\n');
  // ~4 tokens of chat framing per message
  const framing = Array.isArray(b.messages) ? b.messages.length * 4 : 0;
  return { input: count(promptText) + (promptText ? framing : 0), output: count(outputText), cachedRead: 0, cacheWrite: 0, reasoning: 0, estimated: true };
}

/** USD cost. `input` includes cached tokens (OpenAI semantics). Missing cache prices fall back to the input price. */
export function computeCost(u: Usage, m: Pick<Model, 'priceInputPerM' | 'priceOutputPerM' | 'priceCachedReadPerM' | 'priceCacheWritePerM'>): number {
  const pin = m.priceInputPerM ?? 0;
  const pout = m.priceOutputPerM ?? 0;
  const pcr = m.priceCachedReadPerM ?? pin;
  const pcw = m.priceCacheWritePerM ?? pin;
  const uncached = Math.max(0, u.input - u.cachedRead - u.cacheWrite);
  return (uncached * pin + u.cachedRead * pcr + u.cacheWrite * pcw + u.output * pout) / 1e6;
}
