import type { Provider } from '../db/types.js';
import type { ModelInfo } from '../db/repos/models.js';
import type { SseEvent } from './sse.js';

export type { ModelInfo, SseEvent };

export type Endpoint = 'chat' | 'completions' | 'embeddings' | 'messages';

export interface Usage {
  input: number;
  output: number;
  cachedRead: number;
  cacheWrite: number;
  reasoning: number;
  estimated: boolean;
}

export interface UpstreamRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
}

export type ErrorClass = 'rate_limited' | 'server_error' | 'auth_error' | 'client_error';

export type FetchFn = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export interface StreamItem {
  /** A chunk to forward to the client (already in the client's wire format). */
  chunk?: any;
  /** Raw SSE event to forward as-is (passthrough endpoints). */
  raw?: SseEvent;
  usage?: Usage;
  /** Text produced so far, used for usage estimation when the provider reports none. */
  text?: string;
}

export interface ProviderAdapter {
  supports(e: Endpoint): boolean;
  listModels(p: Provider, key: string, fetchFn: FetchFn): Promise<ModelInfo[]>;
  buildRequest(e: Endpoint, body: any, upstreamModelId: string, p: Provider, key: string): UpstreamRequest;
  parseResponse(e: Endpoint, json: any): { body: any; usage: Usage | null };
  parseStream(e: Endpoint, events: AsyncIterable<SseEvent>): AsyncIterable<StreamItem>;
  classifyError(status: number): ErrorClass;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cachedRead: 0, cacheWrite: 0, reasoning: 0, estimated: false });

export function classifyStatus(status: number): ErrorClass {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth_error';
  if (status >= 500 || status === 408) return 'server_error';
  return 'client_error';
}

export const joinUrl = (base: string, path: string) => base.replace(/\/+$/, '') + path;

export async function fetchJson(fetchFn: FetchFn, url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetchFn(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
