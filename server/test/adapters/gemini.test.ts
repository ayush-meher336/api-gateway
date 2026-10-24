import { describe, it, expect } from 'vitest';
import { getAdapter } from '../../src/adapters/registry.js';
import { parseSse } from '../../src/adapters/sse.js';
import { provider, sseBytes, collect } from '../helpers/fixtures.js';

const g = getAdapter('gemini');
const p = provider({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });

describe('gemini adapter', () => {
  it('translates chat into generateContent', () => {
    const r = g.buildRequest(
      'chat',
      {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }] },
          { role: 'assistant', content: 'Hello', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
          { role: 'tool', tool_call_id: 'c1', name: 'f', content: '{"ok":true}' },
        ],
        temperature: 0.5,
        max_tokens: 50,
        top_p: 0.9,
        stop: 'END',
        tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      },
      'gemini-2.5-flash', p, 'gk',
    );
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(r.headers['x-goog-api-key']).toBe('gk');
    const b = JSON.parse(r.body!);
    expect(b.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(b.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Hi' }, { inlineData: { mimeType: 'image/jpeg', data: 'BBBB' } }] });
    expect(b.contents[1]).toEqual({ role: 'model', parts: [{ text: 'Hello' }, { functionCall: { name: 'f', args: { x: 1 } } }] });
    expect(b.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] });
    expect(b.generationConfig).toEqual({ temperature: 0.5, maxOutputTokens: 50, topP: 0.9, stopSequences: ['END'] });
    expect(b.tools).toEqual([{ functionDeclarations: [{ name: 'f', parameters: { type: 'object' } }] }]);
  });

  it('uses streamGenerateContent with alt=sse when streaming', () => {
    const r = g.buildRequest('chat', { stream: true, messages: [{ role: 'user', content: 'x' }] }, 'm', p, 'k');
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse');
  });

  it('parses response and usage', () => {
    const { body, usage } = g.parseResponse('chat', {
      candidates: [{ content: { parts: [{ text: 'Hi ' }, { text: 'there' }, { functionCall: { name: 'f', args: { a: 1 } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, cachedContentTokenCount: 6, thoughtsTokenCount: 3 },
      modelVersion: 'gemini-2.5-flash',
    });
    expect(body.choices[0].message.content).toBe('Hi there');
    expect(body.choices[0].message.tool_calls[0].function).toEqual({ name: 'f', arguments: '{"a":1}' });
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(usage).toEqual({ input: 10, output: 7, cachedRead: 6, cacheWrite: 0, reasoning: 3, estimated: false });
  });

  it('parses a stream', async () => {
    const events = parseSse(
      sseBytes([
        JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'MAX_TOKENS' }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2 },
        }),
      ]),
    );
    const out = await collect(g.parseStream('chat', events));
    const chunks = out.filter((o) => o.chunk).map((o) => o.chunk);
    expect(chunks.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('Hello');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('length');
    expect(out.at(-1)!.usage).toMatchObject({ input: 2, output: 2 });
  });

  it('translates embeddings both ways', () => {
    const r = g.buildRequest('embeddings', { input: ['a', 'b'] }, 'text-embedding-004', p, 'k');
    expect(r.url).toMatch(/models\/text-embedding-004:batchEmbedContents$/);
    expect(JSON.parse(r.body!).requests[1]).toEqual({ model: 'models/text-embedding-004', content: { parts: [{ text: 'b' }] } });
    const { body } = g.parseResponse('embeddings', { embeddings: [{ values: [1, 2] }, { values: [3] }] });
    expect(body.data).toEqual([
      { object: 'embedding', index: 0, embedding: [1, 2] },
      { object: 'embedding', index: 1, embedding: [3] },
    ]);
  });

  it('lists models stripping the models/ prefix', async () => {
    const fetchFn = (async (url: string) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
      return new Response(
        JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
        }),
      );
    }) as any;
    const ms = await g.listModels(p, 'k', fetchFn);
    expect(ms[0]).toMatchObject({ upstreamModelId: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', contextLength: 1048576 });
    expect(ms[0].capabilities).toMatchObject({ chat: true, embeddings: false });
    expect(ms[1].capabilities).toMatchObject({ chat: false, embeddings: true });
  });
});
