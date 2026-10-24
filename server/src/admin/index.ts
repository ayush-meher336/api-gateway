import type { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { GatewayError } from '../errors.js';
import type { Services } from '../services.js';
import { SessionStore, SESSION_COOKIE } from './session.js';
import { authRoutes } from './routes/auth.js';
import { providerRoutes } from './routes/providers.js';
import { upstreamKeyRoutes } from './routes/upstreamKeys.js';
import { modelRoutes } from './routes/models.js';
import { gatewayKeyRoutes } from './routes/gatewayKeys.js';
import { insightRoutes } from './routes/insights.js';
import { settingsRoutes } from './routes/settings.js';
import { applySettings } from './settings.js';

const PUBLIC = new Set(['/admin/api/auth/status', '/admin/api/auth/setup', '/admin/api/auth/login']);

export async function registerAdmin(root: FastifyInstance, s: Services, dataDir: string) {
  applySettings(s.repos);
  const sessions = new SessionStore();
  await root.register(
    async (app) => {
      await app.register(cookie);
      await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });
      app.addHook('onRequest', async (req) => {
        // CSRF: every localhost port counts as same-site, so SameSite cookies alone don't stop another local
        // page from posting here. A custom header forces a CORS preflight, which cross-origin pages fail.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const site = req.headers['sec-fetch-site'];
          if (req.headers['x-gateway-admin'] !== '1' || (site && site !== 'same-origin' && site !== 'none')) {
            throw new GatewayError(403, 'permission_error', 'csrf_check_failed', 'Cross-site request blocked');
          }
        }
        if (PUBLIC.has(req.url.split('?')[0])) return;
        if (!sessions.valid(req.cookies[SESSION_COOKIE])) {
          throw new GatewayError(401, 'authentication_error', 'not_logged_in', 'Log in to the dashboard first');
        }
      });
      const ctx = { app, s, sessions, dataDir };
      authRoutes(ctx);
      providerRoutes(ctx);
      upstreamKeyRoutes(ctx);
      modelRoutes(ctx);
      gatewayKeyRoutes(ctx);
      insightRoutes(ctx);
      settingsRoutes(ctx);
    },
    { prefix: '/admin/api' },
  );
}
