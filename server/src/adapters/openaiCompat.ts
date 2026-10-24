import type { Provider } from '../db/types.js';
import {
  classifyStatus, fetchJson, joinUrl,
  type Endpoint, type FetchFn, type ModelInfo, type ProviderAdapter, type SseEvent, type StreamItem, type Usage,
} from './types.js';

const PATHS: Record<Exclude<Endpoint, 'messages'>, string> = {
  chat: '/chat/completions',
  completions: '/completions',
  embeddings: '/embeddings',
};

export function openaiUsage(u: any): Usage | null {
  if (!u || typeof u !== 'object') return null;
  return {
    input: u.prompt_tokens ?? u.input_tokens ?? 0,
    output: u.completion_tokens ?? u.output_tokens ?? 0,
    cachedRead: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
    cacheWrite: 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
    estimated: false,
  };
}

function guessCaps(id: string): ModelInfo['capabilities'] {
  const embeddings = /embed/i.test(id);
  return { chat: !embeddings, embeddings, vision: /vision|4o|gpt-4\.1|gpt-5|vl|pixtral|llava|gemini|claude/i.test(id) };
}

export const openaiCompatAdapter: ProviderAdapter = {
  supports: (e) => e !== 'messages',

  async listModels(p: Provider, key: string, fetchFn: FetchFn): Promise<ModelInfo[]> {
    const json = await fetchJson(fetchFn, joinUrl(p.baseUrl, '/models'), { authorization: `Bearer ${key}`, ...p.extraHeaders });
    const list: any[] = Array.isArray(json) ? json : (json.data ?? json.models ?? []);
    return list
      .filter((m) => m && (m.id || m.name))
      .map((m) => {
        const id = String(m.id ?? m.name);
        const ctx = m.context_length ?? m.context_window ?? m.max_context_length ?? m.top_provider?.context_length;
        return {
          upstreamModelId: id,
          displayName: m.name && m.name !== id ? String(m.name) : undefined,
          contextLength: typeof ctx === 'number' ? ctx : undefined,
          capabilities: guessCaps(id),
        };
      });
  },

  buildRequest(e, body, upstreamModelId, p, key) {
    if (e === 'messages') throw new Error('messages endpoint not supported by openai-compatible providers');
    const out = { ...body, model: upstreamModelId };
    if (e === 'chat' && out.stream) out.stream_options = { ...(out.stream_options ?? {}), include_usage: true };
    return {
      url: joinUrl(p.baseUrl, PATHS[e]),
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...p.extraHeaders },
      body: JSON.stringify(out),
    };
  },

  parseResponse(_e, json) {
    return { body: json, usage: openaiUsage(json?.usage) };
  },

  async *parseStream(_e, events: AsyncIterable<SseEvent>): AsyncIterable<StreamItem> {
    let text = '';
    for await (const ev of events) {
      if (ev.data === '[DONE]') return;
      let chunk: any;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk?.error) throw Object.assign(new Error(chunk.error.message ?? 'upstream stream error'), { upstream: chunk.error });
      const delta = chunk?.choices?.[0]?.delta;
      if (delta?.content) text += delta.content;
      if (typeof chunk?.choices?.[0]?.text === 'string') text += chunk.choices[0].text;
      const usage = openaiUsage(chunk?.usage);
      yield usage ? { chunk, usage, text } : { chunk, text };
    }
  },

  classifyError: classifyStatus,
};
