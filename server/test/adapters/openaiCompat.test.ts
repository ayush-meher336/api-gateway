import { describe, it, expect } from 'vitest';
import { getAdapter, defaultBaseUrl } from '../../src/adapters/registry.js';
import { parseSse } from '../../src/adapters/sse.js';
import { provider, sseBytes, collect } from '../helpers/fixtures.js';

const a = getAdapter('openai');

describe('openai-compatible adapter', () => {
  it('builds chat request with swapped model, auth and extra headers', () => {
    const r = a.buildRequest('chat', { model: 'alias', messages: [] }, 'gpt-4o', provider({ extraHeaders: { 'X-T': '1' } }), 'sk-1');
    expect(r.url).toBe('https://api.example.com/v1/chat/completions');
    expect(r.headers.authorization).toBe('Bearer sk-1');
    expect(r.headers['X-T']).toBe('1');
    const body = JSON.parse(r.body!);
    expect(body.model).toBe('gpt-4o');
    expect(body.stream_options).toBeUndefined();
  });

  it('injects include_usage only for streaming chat', () => {
    const r = a.buildRequest('chat', { model: 'x', stream: true, messages: [] }, 'm', provider(), 'k');
    expect(JSON.parse(r.body!).stream_options).toEqual({ include_usage: true });
  });

  it('maps embeddings and completions paths', () => {
    expect(a.buildRequest('embeddings', { model: 'x', input: 'hi' }, 'e', provider(), 'k').url).toMatch(/\/embeddings$/);
    expect(a.buildRequest('completions', { model: 'x', prompt: 'hi' }, 'c', provider(), 'k').url).toMatch(/\/completions$/);
    expect(a.supports('messages')).toBe(false);
  });

  it('parses usage incl. cached and reasoning tokens', () => {
    const { usage } = a.parseResponse('chat', {
      choices: [{ message: { content: 'hi' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 60 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });
    expect(usage).toEqual({ input: 100, output: 20, cachedRead: 60, cacheWrite: 0, reasoning: 5, estimated: false });
  });

  it('returns null usage when absent', () => {
    expect(a.parseResponse('chat', { choices: [] }).usage).toBeNull();
  });

  it('parses a stream, yields chunks and final usage, stops at [DONE]', async () => {
    const events = parseSse(
      sseBytes([
        JSON.stringify({ choices: [{ delta: { content: 'He' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'llo' } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
        '[DONE]',
        JSON.stringify({ choices: [{ delta: { content: 'IGNORED' } }] }),
      ]),
    );
    const out = await collect(a.parseStream('chat', events));
    const text = out.map((o) => o.chunk?.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Hello');
    expect(out.find((o) => o.usage)?.usage).toMatchObject({ input: 3, output: 2 });
  });

  it('parseSse handles events split across chunks with CRLF and named events', async () => {
    const ev = await collect(parseSse(sseBytes(['{"a":1}', { event: 'ping', data: '{}' }], 3)));
    expect(ev).toEqual([{ data: '{"a":1}' }, { event: 'ping', data: '{}' }]);
  });

  it('classifies errors', () => {
    expect(a.classifyError(429)).toBe('rate_limited');
    expect(a.classifyError(401)).toBe('auth_error');
    expect(a.classifyError(403)).toBe('auth_error');
    expect(a.classifyError(500)).toBe('server_error');
    expect(a.classifyError(503)).toBe('server_error');
    expect(a.classifyError(408)).toBe('server_error');
    expect(a.classifyError(400)).toBe('client_error');
    expect(a.classifyError(404)).toBe('client_error');
  });

  it('lists models from /models', async () => {
    const fetchFn = (async (url: string, init: any) => {
      expect(url).toBe('https://api.example.com/v1/models');
      expect(init.headers.authorization).toBe('Bearer k');
      return new Response(JSON.stringify({ data: [{ id: 'gpt-4o', context_length: 128000 }, { id: 'text-embedding-3-small' }] }));
    }) as any;
    const models = await a.listModels(provider(), 'k', fetchFn);
    expect(models[0]).toMatchObject({ upstreamModelId: 'gpt-4o', contextLength: 128000 });
    expect(models[1].capabilities?.embeddings).toBe(true);
  });

  it('knows default base urls', () => {
    expect(defaultBaseUrl('groq')).toBe('https://api.groq.com/openai/v1');
    expect(defaultBaseUrl('ollama')).toBe('http://127.0.0.1:11434/v1');
  });
});
