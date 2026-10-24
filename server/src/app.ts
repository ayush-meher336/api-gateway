import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GatewayError, errorBody } from './errors.js';
import type { Services } from './services.js';
import { registerProxyRoutes } from './proxy/routes.js';
import { registerAdmin } from './admin/index.js';

export interface AppOptions {
  logger?: any;
  /** Where backups are staged for restore. Defaults to ./data. */
  dataDir?: string;
  /** Built dashboard (web/dist). Served with SPA fallback when present. */
  webDir?: string;
}

const isApiPath = (url: string) => url.startsWith('/v1/') || url === '/v1' || url.startsWith('/admin/api') || url === '/health';

export function buildApp(s: Services, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    // per-request access logs would duplicate the request_logs table
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: false,
    return503OnClosing: true,
  }) as unknown as FastifyInstance;

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof GatewayError) return reply.code(err.status).send(err.toBody());
    if (err?.name === 'ZodError') {
      const msg = err.issues?.map((i: any) => `${i.path?.join('.') || 'body'}: ${i.message}`).join('; ') ?? 'Invalid request';
      return reply.code(400).send(errorBody('invalid_request_error', 'validation_error', msg));
    }
    if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
      return reply.code(409).send(errorBody('invalid_request_error', 'already_exists', 'An item with that name or value already exists'));
    }
    const status = typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) {
      s.logger.error({ err, url: req.url }, 'unhandled request error');
      return reply.code(500).send(errorBody('internal_error', 'internal_error', 'The gateway hit an unexpected error'));
    }
    const code = err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'body_too_large' : status === 415 ? 'unsupported_media_type' : 'invalid_request';
    return reply.code(status).send(errorBody('invalid_request_error', code, err.message ?? 'Bad request'));
  });

  const webDir = opts.webDir && existsSync(join(opts.webDir, 'index.html')) ? opts.webDir : null;
  // wildcard mode looks files up per request, so a dashboard rebuilt while running is served without a restart
  if (webDir) {
    app.register(fastifyStatic, { root: webDir, index: false });
    app.get('/', (_req, reply) => reply.type('text/html').sendFile('index.html'));
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    const looksLikeFile = /\.[a-z0-9]+$/i.test(path.split('/').pop() ?? '');
    if (webDir && req.method === 'GET' && !isApiPath(path) && !looksLikeFile) {
      return reply.type('text/html').sendFile('index.html');
    }
    reply.code(404).send(errorBody('invalid_request_error', 'not_found', `No route for ${req.method} ${path}`));
  });

  app.get('/health', async () => {
    let db = true;
    try {
      s.db.prepare('SELECT 1').get();
    } catch {
      db = false;
    }
    return { status: db ? 'ok' : 'degraded', db, uptimeS: Math.round((Date.now() - s.startedAt) / 1000), pendingLogs: s.logWriter.pending };
  });

  registerProxyRoutes(app, s);
  app.register(async (scope) => registerAdmin(scope, s, opts.dataDir ?? resolve('data')));
  return app;
}
