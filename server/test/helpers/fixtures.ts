import type { Provider } from '../../src/db/types.js';

export function provider(over: Partial<Provider> = {}): Provider {
  return {
    id: 1,
    name: 'p',
    type: 'openai',
    baseUrl: 'https://api.example.com/v1',
    extraHeaders: {},
    timeoutMs: 5000,
    enabled: true,
    priority: 0,
    createdAt: 0,
    ...over,
  };
}

/** Turns a list of SSE `data:` payloads into a byte stream split at awkward boundaries. */
export async function* sseBytes(events: (string | { event: string; data: string })[], chunkSize = 7) {
  const text = events
    .map((e) => (typeof e === 'string' ? `data: ${e}\r\n\r\n` : `event: ${e.event}\ndata: ${e.data}\n\n`))
    .join('');
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
