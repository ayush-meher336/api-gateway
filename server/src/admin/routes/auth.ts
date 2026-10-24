import { hashPassword, verifyPassword } from '../../crypto/gatewayKey.js';
import { GatewayError } from '../../errors.js';
import { type AdminContext } from '../context.js';
import { changePassword, passwordBody } from '../schemas.js';
import { SESSION_COOKIE } from '../session.js';

export function authRoutes({ app, s, sessions }: AdminContext) {
  const hash = () => s.repos.settings.get<string | null>('adminPassword', null);
  const cookieOpts = (maxAge: number) => ({ path: '/', httpOnly: true, sameSite: 'strict' as const, maxAge });

  app.get('/auth/status', async (req) => ({
    setupRequired: !hash(),
    authenticated: sessions.valid(req.cookies[SESSION_COOKIE]),
  }));

  app.post('/auth/setup', async (req, reply) => {
    if (hash()) throw new GatewayError(409, 'invalid_request_error', 'already_setup', 'An admin password is already set');
    const { password } = passwordBody.parse(req.body);
    s.repos.settings.set('adminPassword', hashPassword(password));
    const { token, maxAgeS } = sessions.create();
    reply.setCookie(SESSION_COOKIE, token, cookieOpts(maxAgeS));
    return { ok: true };
  });

  app.post('/auth/login', async (req, reply) => {
    if (sessions.loginBlocked(req.ip)) {
      throw new GatewayError(429, 'rate_limit_error', 'too_many_attempts', 'Too many login attempts. Wait a minute and try again.');
    }
    const body = (req.body ?? {}) as { password?: unknown };
    const stored = hash();
    if (!stored) throw new GatewayError(409, 'invalid_request_error', 'setup_required', 'Set an admin password first');
    if (typeof body.password !== 'string' || !verifyPassword(body.password, stored)) {
      sessions.recordFailure(req.ip);
      throw new GatewayError(401, 'authentication_error', 'invalid_password', 'Wrong password');
    }
    sessions.clearFailures(req.ip);
    const { token, maxAgeS } = sessions.create();
    reply.setCookie(SESSION_COOKIE, token, cookieOpts(maxAgeS));
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    sessions.destroy(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/auth/password', async (req, reply) => {
    const { current, next } = changePassword.parse(req.body);
    if (!verifyPassword(current, hash() ?? '')) throw new GatewayError(401, 'authentication_error', 'invalid_password', 'Current password is wrong');
    s.repos.settings.set('adminPassword', hashPassword(next));
    sessions.destroyAll();
    const { token, maxAgeS } = sessions.create();
    reply.setCookie(SESSION_COOKIE, token, cookieOpts(maxAgeS));
    return { ok: true };
  });
}
