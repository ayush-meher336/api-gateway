import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../errors.js';
import type { Services } from '../services.js';
import type { SessionStore } from './session.js';

export interface AdminContext {
  app: FastifyInstance;
  s: Services;
  sessions: SessionStore;
  dataDir: string;
}

export const notFound = (what: string) => new GatewayError(404, 'invalid_request_error', 'not_found', `${what} not found`);
export const badRequest = (code: string, message: string) => new GatewayError(400, 'invalid_request_error', code, message);

export function must<T>(v: T | null | undefined, what: string): T {
  if (v == null) throw notFound(what);
  return v;
}
