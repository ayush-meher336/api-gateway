import { classifyStatus, fetchJson, joinUrl, type ProviderAdapter, type StreamItem, type Usage } from './types.js';
import { chunk, completion, contentParts, contentText, parseDataUrl, safeJson, toStopList } from './openaiShapes.js';

const FINISH: Record<string, string> = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', PROHIBITED_CONTENT: 'content_filter' };

function geminiUsage(u: any): Usage | null {
  if (!u) return null;
  const reasoning = u.thoughtsTokenCount ?? 0;
  return {
    input: u.promptTokenCount ?? 0,
    output: (u.candidatesTokenCount ?? 0) + reasoning,
    cachedRead: u.cachedContentTokenCount ?? 0,
    cacheWrite: 0,
    reasoning,
    estimated: false,
  };
}

function convertPart(p: any): any {
  if (p.type === 'text') return { text: p.text };
  if (p.type === 'image_url') {
    const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
    const d = parseDataUrl(url ?? '');
    return d ? { inlineData: d } : { fileData: { fileUri: url } };
  }
  return p;
}

function toGeminiBody(body: any) {
  const system: string[] = [];
  const contents: any[] = [];
  const toolNames = new Map<string, string>();
  for (const m of body.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      system.push(contentText(m.content));
    } else if (m.role === 'tool') {
      const name = m.name ?? toolNames.get(m.tool_call_id) ?? 'tool';
      const resp = safeJson(typeof m.content === 'string' ? m.content : contentText(m.content));
      contents.push({ role: 'user', parts: [{ functionResponse: { name, response: typeof resp === 'object' && resp ? resp : { result: resp } } }] });
    } else {
      const parts = contentParts(m.content).map(convertPart);
      for (const tc of m.tool_calls ?? []) {
        toolNames.set(tc.id, tc.function?.name);
        parts.push({ functionCall: { name: tc.function?.name, args: safeJson(tc.function?.arguments) } });
      }
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
    }
  }
  const gc: any = {};
  if (body.temperature !== undefined) gc.temperature = body.temperature;
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined) gc.maxOutputTokens = max;
  if (body.top_p !== undefined) gc.topP = body.top_p;
  if (body.top_k !== undefined) gc.topK = body.top_k;
  const stop = toStopList(body.stop);
  if (stop) gc.stopSequences = stop;
  if (body.response_format?.type === 'json_object' || body.response_format?.type === 'json_schema') gc.responseMimeType = 'application/json';
  if (body.response_format?.json_schema?.schema) gc.responseSchema = body.response_format.json_schema.schema;
  const out: any = { contents };
  if (system.length) out.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (Object.keys(gc).length) out.generationConfig = gc;
  if (body.tools?.length) {
    out.tools = [
      {
        functionDeclarations: body.tools
          .filter((t: any) => t.type === 'function')
          .map((t: any) => ({ name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), ...(t.function.parameters ? { parameters: t.function.parameters } : {}) })),
      },
    ];
  }
  return out;
}

function candidateToOpenAI(c: any) {
  const parts: any[] = c?.content?.parts ?? [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: `call_${i}_${p.functionCall.name}`, name: p.functionCall.name, args: p.functionCall.args }));
  const finish = toolCalls.length ? 'tool_calls' : c?.finishReason ? (FINISH[c.finishReason] ?? 'stop') : null;
  return { text, toolCalls, finish };
}

export const geminiAdapter: ProviderAdapter = {
  supports: (e) => e === 'chat' || e === 'embeddings',

  async listModels(p, key, fetchFn) {
    const json = await fetchJson(fetchFn, joinUrl(p.baseUrl, '/models?pageSize=1000'), { 'x-goog-api-key': key, ...p.extraHeaders });
    return (json.models ?? []).map((m: any) => {
      const methods: string[] = m.supportedGenerationMethods ?? [];
      const chat = methods.includes('generateContent');
      return {
        upstreamModelId: String(m.name).replace(/^models\//, ''),
        displayName: m.displayName,
        contextLength: m.inputTokenLimit,
        capabilities: { chat, embeddings: methods.includes('embedContent'), vision: chat, tools: chat },
      };
    });
  },

  buildRequest(e, body, model, p, key) {
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': key, ...p.extraHeaders };
    if (e === 'embeddings') {
      const inputs: string[] = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')];
      return {
        url: joinUrl(p.baseUrl, `/models/${model}:batchEmbedContents`),
        method: 'POST',
        headers,
        body: JSON.stringify({ requests: inputs.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] } })) }),
      };
    }
    if (e !== 'chat') throw new Error(`${e} is not supported by Gemini`);
    const path = body.stream ? `/models/${model}:streamGenerateContent?alt=sse` : `/models/${model}:generateContent`;
    return { url: joinUrl(p.baseUrl, path), method: 'POST', headers, body: JSON.stringify(toGeminiBody(body)) };
  },

  parseResponse(e, json) {
    if (e === 'embeddings') {
      return {
        body: { object: 'list', data: (json?.embeddings ?? []).map((x: any, index: number) => ({ object: 'embedding', index, embedding: x.values })), model: '' },
        usage: null,
      };
    }
    const usage = geminiUsage(json?.usageMetadata);
    const { text, toolCalls, finish } = candidateToOpenAI(json?.candidates?.[0]);
    return {
      body: completion({
        id: json?.responseId,
        model: json?.modelVersion,
        content: text || (toolCalls.length ? null : ''),
        toolCalls,
        finishReason: finish ?? 'stop',
        usage: usage ? { prompt: usage.input, completion: usage.output, cached: usage.cachedRead, reasoning: usage.reasoning } : undefined,
      }),
      usage,
    };
  },

  async *parseStream(_e, events): AsyncIterable<StreamItem> {
    let text = '';
    let usage: Usage | null = null;
    const id = `chatcmpl-gemini-${Date.now().toString(36)}`;
    let first = true;
    let toolIdx = 0;
    for await (const ev of events) {
      let d: any;
      try {
        d = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (d.error) throw Object.assign(new Error(d.error.message ?? 'upstream stream error'), { upstream: d.error });
      usage = geminiUsage(d.usageMetadata) ?? usage;
      const c = candidateToOpenAI(d.candidates?.[0]);
      text += c.text;
      const delta: any = first ? { role: 'assistant' } : {};
      first = false;
      if (c.text) delta.content = c.text;
      if (c.toolCalls.length) {
        delta.tool_calls = c.toolCalls.map((t) => ({ index: toolIdx++, id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) } }));
      }
      yield { chunk: chunk(id, d.modelVersion ?? '', delta, c.finish), text };
    }
    if (usage) yield { usage, text };
  },

  classifyError: classifyStatus,
};
