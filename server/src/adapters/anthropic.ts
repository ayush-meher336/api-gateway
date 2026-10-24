import { classifyStatus, fetchJson, joinUrl, type ProviderAdapter, type StreamItem, type Usage } from './types.js';
import { chunk, completion, contentParts, contentText, parseDataUrl, safeJson, toStopList } from './openaiShapes.js';

const STOP: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' };

/** Anthropic reports input excluding cache; normalise to OpenAI semantics (input includes cached). */
function anthropicUsage(u: any): Usage | null {
  if (!u) return null;
  const cachedRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return { input: (u.input_tokens ?? 0) + cachedRead + cacheWrite, output: u.output_tokens ?? 0, cachedRead, cacheWrite, reasoning: 0, estimated: false };
}

function convertPart(p: any): any {
  if (p.type === 'text') return { type: 'text', text: p.text };
  if (p.type === 'image_url') {
    const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
    const d = parseDataUrl(url ?? '');
    return d ? { type: 'image', source: { type: 'base64', media_type: d.mimeType, data: d.data } } : { type: 'image', source: { type: 'url', url } };
  }
  return p; // already Anthropic-native (e.g. document blocks with cache_control)
}

function toAnthropicBody(body: any, model: string) {
  const system: string[] = [];
  const messages: any[] = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    const last = messages.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') system.push(contentText(m.content));
    else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : contentText(m.content) }]);
    else if (m.role === 'assistant') {
      const blocks = contentParts(m.content).map(convertPart);
      for (const tc of m.tool_calls ?? []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: safeJson(tc.function?.arguments) });
      push('assistant', blocks);
    } else push('user', contentParts(m.content).map(convertPart));
  }
  const out: any = { model, messages, max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096 };
  if (system.length) out.system = system.join('\n\n');
  for (const k of ['temperature', 'top_p', 'top_k', 'stream', 'thinking'] as const) if (body[k] !== undefined) out[k] = body[k];
  // Anthropic metadata accepts only user_id; arbitrary OpenAI metadata would be a 400
  const userId = body.metadata?.user_id ?? body.user;
  if (typeof userId === 'string' && userId) out.metadata = { user_id: userId };
  const stop = toStopList(body.stop);
  if (stop) out.stop_sequences = stop;
  if (body.tools?.length) {
    out.tools = body.tools.map((t: any) =>
      t.type === 'function' ? { name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), input_schema: t.function.parameters ?? { type: 'object' } } : t,
    );
  }
  const tc = body.tool_choice;
  if (tc === 'auto') out.tool_choice = { type: 'auto' };
  else if (tc === 'required') out.tool_choice = { type: 'any' };
  else if (tc === 'none') out.tool_choice = { type: 'none' };
  else if (tc?.function?.name) out.tool_choice = { type: 'tool', name: tc.function.name };
  return out;
}

export const anthropicAdapter: ProviderAdapter = {
  supports: (e) => e === 'chat' || e === 'messages',

  async listModels(p, key, fetchFn) {
    const json = await fetchJson(fetchFn, joinUrl(p.baseUrl, '/models?limit=1000'), {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...p.extraHeaders,
    });
    return (json.data ?? []).map((m: any) => ({
      upstreamModelId: m.id,
      displayName: m.display_name,
      capabilities: { chat: true, vision: true, tools: true },
    }));
  },

  buildRequest(e, body, model, p, key) {
    if (e !== 'chat' && e !== 'messages') throw new Error(`${e} is not supported by Anthropic`);
    const payload = e === 'messages' ? { ...body, model } : toAnthropicBody(body, model);
    return {
      url: joinUrl(p.baseUrl, '/messages'),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', ...p.extraHeaders },
      body: JSON.stringify(payload),
    };
  },

  parseResponse(e, json) {
    const usage = anthropicUsage(json?.usage);
    if (e === 'messages') return { body: json, usage };
    const blocks: any[] = json?.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input }));
    return {
      body: completion({
        id: json?.id,
        model: json?.model,
        content: text || (toolCalls.length ? null : ''),
        toolCalls,
        finishReason: STOP[json?.stop_reason] ?? 'stop',
        usage: usage ? { prompt: usage.input, completion: usage.output, cached: usage.cachedRead } : undefined,
      }),
      usage,
    };
  },

  async *parseStream(e, events): AsyncIterable<StreamItem> {
    const raw: any = {};
    let id = 'chatcmpl-anthropic';
    let model = '';
    let text = '';
    const toolIndex = new Map<number, number>(); // anthropic block index -> openai tool index
    for await (const ev of events) {
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const type = d.type ?? ev.event;
      if (type === 'error') throw Object.assign(new Error(d.error?.message ?? 'upstream stream error'), { upstream: d.error });
      if (type === 'message_start') {
        Object.assign(raw, d.message?.usage ?? {});
        id = d.message?.id ?? id;
        model = d.message?.model ?? model;
      } else if (type === 'message_delta' && d.usage) Object.assign(raw, d.usage);
      else if (type === 'content_block_delta' && d.delta?.type === 'text_delta') text += d.delta.text;

      if (e === 'messages') {
        yield { raw: ev, text };
        continue;
      }
      if (type === 'message_start') yield { chunk: chunk(id, model, { role: 'assistant', content: '' }), text };
      else if (type === 'content_block_start' && d.content_block?.type === 'tool_use') {
        const idx = toolIndex.size;
        toolIndex.set(d.index, idx);
        yield { chunk: chunk(id, model, { tool_calls: [{ index: idx, id: d.content_block.id, type: 'function', function: { name: d.content_block.name, arguments: '' } }] }), text };
      } else if (type === 'content_block_delta') {
        if (d.delta?.type === 'text_delta') yield { chunk: chunk(id, model, { content: d.delta.text }), text };
        else if (d.delta?.type === 'input_json_delta') {
          yield { chunk: chunk(id, model, { tool_calls: [{ index: toolIndex.get(d.index) ?? 0, function: { arguments: d.delta.partial_json } }] }), text };
        }
      } else if (type === 'message_delta' && d.delta?.stop_reason) {
        yield { chunk: chunk(id, model, {}, STOP[d.delta.stop_reason] ?? 'stop'), text };
      }
    }
    const usage = anthropicUsage(raw);
    if (usage) yield { usage, text };
  },

  classifyError: (s) => (s === 529 ? 'server_error' : classifyStatus(s)),
};
