import Fastify, { type FastifyRequest } from 'fastify';

export interface Seen {
  url: string;
  headers: Record<string, any>;
  body: any;
}

export type Reply =
  | { status?: number; json: unknown; headers?: Record<string, string> }
  | { status?: number; sse: string[]; delayMs?: number; hangAfter?: boolean; failAfter?: number }
  | { hang: true };

/**
 * A fake provider. `handler` decides each reply; every request is recorded in `seen`.
 * SSE replies send `data: <x>` frames; `hangAfter` keeps the connection open after the frames,
 * `failAfter` destroys the socket after N frames.
 */
export async function startMockUpstream(handler: (req: FastifyRequest, n: number) => Reply) {
  const seen: Seen[] = [];
  const app = Fastify({ forceCloseConnections: true });
  let n = 0;
  const aborted: string[] = [];
  app.all('/*', async (req, reply) => {
    seen.push({ url: req.url, headers: req.headers, body: req.body });
    const r = handler(req, n++);
    if ('hang' in r) {
      req.raw.on('close', () => aborted.push(req.url));
      reply.hijack();
      return;
    }
    if ('json' in r) {
      reply.code(r.status ?? 200).headers(r.headers ?? {}).send(r.json);
      return reply;
    }
    reply.hijack();
    const res = reply.raw;
    req.raw.on('close', () => {
      if (!res.writableEnded) aborted.push(req.url);
    });
    res.writeHead(r.status ?? 200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < r.sse.length; i++) {
      if (r.failAfter !== undefined && i === r.failAfter) {
        // let already-written frames reach the client before cutting the connection
        if (i > 0) await new Promise((ok) => setTimeout(ok, 50));
        res.destroy();
        return;
      }
      res.write(`data: ${r.sse[i]}\n\n`);
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    }
    if (!r.hangAfter) res.end();
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    seen,
    aborted,
    close: () => app.close(),
  };
}

export const chatJson = (content = 'hi', usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({
  id: 'c1',
  object: 'chat.completion',
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage,
});
