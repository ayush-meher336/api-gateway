export interface SseEvent {
  event?: string;
  data: string;
}

/** Incremental SSE parser tolerant of LF/CRLF and arbitrary chunk boundaries. */
export async function* parseSse(stream: AsyncIterable<Uint8Array>): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];

  const flushLine = function* (line: string): Generator<SseEvent> {
    if (line === '') {
      if (data.length) yield event ? { event, data: data.join('\n') } : { data: data.join('\n') };
      event = undefined;
      data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  };

  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.search(/\r\n|\n|\r/)) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
      yield* flushLine(line);
    }
  }
  buf += decoder.decode();
  if (buf) yield* flushLine(buf);
  yield* flushLine('');
}

export function formatSse(data: unknown, event?: string): string {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return (event ? `event: ${event}\n` : '') + `data: ${payload}\n\n`;
}
