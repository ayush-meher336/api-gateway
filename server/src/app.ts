import Fastify, { type FastifyInstance } from 'fastify';
import { GatewayError, errorBody } from './errors.js';
import type { Services } from './services.js';
import { registerProxyRoutes } from './proxy/routes.js';
import { registerAdmin } from './admin/index.js';
import { resolve } from 'node:path';

export interface AppOptions {
  logger?: any;
  /** Where backups are staged for restore. Defaults to ./data. */
  dataDir?: string;
}

export function buildApp(s: Services, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: false,
    disableRequestLogging: true,
  });

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

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorBody('invalid_request_error', 'not_found', `No route for ${req.method} ${req.url.split('?')[0]}`));
  });

  registerProxyRoutes(app, s);
  app.register(async (scope) => registerAdmin(scope, s, opts.dataDir ?? resolve('data')));
  return app;
}
