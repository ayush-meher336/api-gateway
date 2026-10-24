/** Helpers for producing/consuming OpenAI wire shapes in non-OpenAI adapters. */

export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

export function safeJson(s: unknown): any {
  if (typeof s !== 'string') return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

/** Normalises OpenAI message content (string | parts[] | null) to parts. */
export function contentParts(content: any): any[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return Array.isArray(content) ? content : [];
}

export function contentText(content: any): string {
  return contentParts(content)
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export const toStopList = (stop: unknown): string[] | undefined =>
  stop == null ? undefined : Array.isArray(stop) ? stop.map(String) : [String(stop)];

export function completion(opts: {
  id?: string;
  model?: string;
  content: string | null;
  toolCalls?: { id: string; name: string; args: unknown }[];
  finishReason: string | null;
  usage?: { prompt: number; completion: number; cached: number; reasoning?: number };
}) {
  const message: any = { role: 'assistant', content: opts.content };
  if (opts.toolCalls?.length) {
    message.tool_calls = opts.toolCalls.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: typeof t.args === 'string' ? t.args : JSON.stringify(t.args ?? {}) },
    }));
  }
  return {
    id: opts.id ?? `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: opts.model ?? '',
    choices: [{ index: 0, message, finish_reason: opts.finishReason }],
    ...(opts.usage
      ? {
          usage: {
            prompt_tokens: opts.usage.prompt,
            completion_tokens: opts.usage.completion,
            total_tokens: opts.usage.prompt + opts.usage.completion,
            prompt_tokens_details: { cached_tokens: opts.usage.cached },
            ...(opts.usage.reasoning ? { completion_tokens_details: { reasoning_tokens: opts.usage.reasoning } } : {}),
          },
        }
      : {}),
  };
}

export function chunk(id: string, model: string, delta: any, finishReason: string | null = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
