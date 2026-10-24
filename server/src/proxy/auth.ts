import type { FastifyRequest } from 'fastify';
import { hashGatewayKey } from '../crypto/gatewayKey.js';
import type { GatewayKey } from '../db/types.js';
import { GatewayError } from '../errors.js';
import type { Services } from '../services.js';

export function extractKey(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x) return x.trim();
  return null;
}

const normIp = (ip: string) => ip.replace(/^::ffff:/, '');

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Matches an IP against exact addresses or IPv4 CIDR ranges. */
export function ipAllowed(ip: string, allowlist: string[]): boolean {
  if (!allowlist.length) return true;
  const addr = normIp(ip);
  for (const entry of allowlist) {
    const e = entry.trim();
    if (!e) continue;
    if (!e.includes('/')) {
      if (normIp(e) === addr || (e === 'localhost' && (addr === '127.0.0.1' || addr === '::1'))) return true;
      continue;
    }
    const [base, bitsStr] = e.split('/');
    const bits = Number(bitsStr);
    const a = ipv4ToInt(addr);
    const b = ipv4ToInt(base);
    if (a === null || b === null || !(bits >= 0 && bits <= 32)) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if (((a & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

/** Validates the caller's gateway key and its limits. Throws GatewayError with the standard body. */
export function authenticate(req: FastifyRequest, s: Services, now = Date.now()): GatewayKey {
  const plain = extractKey(req);
  if (!plain) throw new GatewayError(401, 'authentication_error', 'invalid_api_key', 'Missing API key. Send "Authorization: Bearer <key>".');
  const gk = s.repos.gatewayKeys.findByHash(hashGatewayKey(plain));
  if (!gk || !gk.enabled) throw new GatewayError(401, 'authentication_error', 'invalid_api_key', 'Invalid or revoked API key');
  if (gk.expiresAt && gk.expiresAt <= now) throw new GatewayError(401, 'authentication_error', 'key_expired', 'This API key has expired');
  if (!ipAllowed(req.ip, gk.ipAllowlist)) throw new GatewayError(403, 'permission_error', 'ip_not_allowed', `IP ${normIp(req.ip)} is not allowed for this key`);
  if (!s.limiter.check('gw', gk.id, { rpm: gk.rpmLimit, tpm: gk.tpmLimit })) {
    throw new GatewayError(429, 'rate_limit_error', 'gateway_limit', 'Rate limit for this API key exceeded. Try again shortly.');
  }
  if (gk.budgetDailyUsd != null || gk.budgetMonthlyUsd != null || gk.tokenQuotaTotal != null) {
    const spend = s.usage.gatewaySpend(gk.id, now);
    if (gk.budgetDailyUsd != null && spend.dayUsd >= gk.budgetDailyUsd) {
      throw new GatewayError(402, 'budget_error', 'budget_exceeded', `Daily budget of $${gk.budgetDailyUsd} reached`);
    }
    if (gk.budgetMonthlyUsd != null && spend.monthUsd >= gk.budgetMonthlyUsd) {
      throw new GatewayError(402, 'budget_error', 'budget_exceeded', `Monthly budget of $${gk.budgetMonthlyUsd} reached`);
    }
    if (gk.tokenQuotaTotal != null && spend.totalTokens >= gk.tokenQuotaTotal) {
      throw new GatewayError(429, 'rate_limit_error', 'token_quota_exceeded', `Token quota of ${gk.tokenQuotaTotal} reached`);
    }
  }
  return gk;
}
