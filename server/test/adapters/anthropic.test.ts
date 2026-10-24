import { describe, it, expect } from 'vitest';
import { getAdapter } from '../../src/adapters/registry.js';
import { parseSse } from '../../src/adapters/sse.js';
import { provider, sseBytes, collect } from '../helpers/fixtures.js';

const a = getAdapter('anthropic');
const p = provider({ type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' });

const convo = {
  model: 'claude',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'system', content: 'Be kind.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
    { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'look', arguments: '{"q":1}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'a cat' },
  ],
  tools: [{ type: 'function', function: { name: 'look', description: 'd', parameters: { type: 'object' } } }],
  tool_choice: 'auto',
  temperature: 0.2,
  stop: ['X'],
};

describe('anthropic adapter', () => {
  it('translates an OpenAI chat request into Messages API', () => {
    const r = a.buildRequest('chat', convo, 'claude-sonnet-4-5', p, 'sk-ant');
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(r.headers['x-api-key']).toBe('sk-ant');
    expect(r.headers['anthropic-version']).toBe('2023-06-01');
    const b = JSON.parse(r.body!);
    expect(b.model).toBe('claude-sonnet-4-5');
    expect(b.system).toBe('Be brief.\n\nBe kind.');
    expect(b.max_tokens).toBe(4096);
    expect(b.temperature).toBe(0.2);
    expect(b.stop_sequences).toEqual(['X']);
    expect(b.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    });
    expect(b.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'look', input: { q: 1 } }] });
    expect(b.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a cat' }] });
    expect(b.tools).toEqual([{ name: 'look', description: 'd', input_schema: { type: 'object' } }]);
    expect(b.tool_choice).toEqual({ type: 'auto' });
  });

  it('maps max_completion_tokens and http image urls', () => {
    const b = JSON.parse(
      a.buildRequest(
        'chat',
        { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }], max_completion_tokens: 10 },
        'm', p, 'k',
      ).body!,
    );
    expect(b.max_tokens).toBe(10);
    expect(b.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'url', url: 'https://x/y.png' } });
  });

  it('translates a tool-use response to OpenAI format with cache usage', () => {
    const { body, usage } = a.parseResponse('chat', {
      id: 'msg_1',
      model: 'claude-sonnet-4-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'tool_use', id: 't9', name: 'look', input: { q: 2 } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
    });
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.content).toBe('Let me look.');
    expect(body.choices[0].message.tool_calls).toEqual([
      { id: 't9', type: 'function', function: { name: 'look', arguments: '{"q":2}' } },
    ]);
    // OpenAI semantics: prompt_tokens includes cached tokens.
    expect(usage).toEqual({ input: 117, output: 5, cachedRead: 100, cacheWrite: 7, reasoning: 0, estimated: false });
    expect(body.usage).toMatchObject({ prompt_tokens: 117, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100 } });
  });

  it('translates a stream into OpenAI chunks with final usage', async () => {
    const ev = (event: string, data: object) => ({ event, data: JSON.stringify({ type: event, ...data }) });
    const events = parseSse(
      sseBytes([
        ev('message_start', { message: { id: 'm1', model: 'c', usage: { input_tokens: 4, cache_read_input_tokens: 2, output_tokens: 1 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
        ev('ping', {}),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
        ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't1', name: 'f' } }),
        ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } }),
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
        ev('message_stop', {}),
      ]),
    );
    const out = await collect(a.parseStream('chat', events));
    const chunks = out.filter((o) => o.chunk).map((o) => o.chunk);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('Hello');
    const toolStart = chunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.id === 't1');
    expect(toolStart.choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, function: { name: 'f', arguments: '' } });
    expect(chunks.some((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments === '{"a"')).toBe(true);
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop');
    expect(out.at(-1)!.usage).toEqual({ input: 6, output: 9, cachedRead: 2, cacheWrite: 0, reasoning: 0, estimated: false });
  });

  it('passes /v1/messages through untouched except the model', async () => {
    const r = a.buildRequest('messages', { model: 'alias', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }, 'claude-x', p, 'k');
    expect(JSON.parse(r.body!)).toEqual({ model: 'claude-x', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] });
    const { body, usage } = a.parseResponse('messages', { content: [], usage: { input_tokens: 1, output_tokens: 2 } });
    expect(body.content).toEqual([]);
    expect(usage?.output).toBe(2);
    const out = await collect(
      a.parseStream('messages', parseSse(sseBytes([{ event: 'message_delta', data: '{"type":"message_delta","usage":{"output_tokens":3}}' }]))),
    );
    expect(out[0].raw).toEqual({ event: 'message_delta', data: '{"type":"message_delta","usage":{"output_tokens":3}}' });
    expect(out.at(-1)!.usage?.output).toBe(3);
  });

  it('does not support embeddings', () => {
    expect(a.supports('embeddings')).toBe(false);
    expect(a.supports('messages')).toBe(true);
  });

  it('lists models', async () => {
    const fetchFn = (async (url: string, init: any) => {
      expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
      expect(init.headers['x-api-key']).toBe('k');
      return new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] }));
    }) as any;
    expect(await a.listModels(p, 'k', fetchFn)).toEqual([
      { upstreamModelId: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', capabilities: { chat: true, vision: true, tools: true } },
    ]);
  });
});
