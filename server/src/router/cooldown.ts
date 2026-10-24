import type { ErrorClass } from '../adapters/types.js';
import type { KeyStatus } from '../db/types.js';

export const COOLDOWN = {
  rateLimitBaseMs: 30_000,
  maxMs: 15 * 60_000,
  serverErrorMs: 15_000,
};

function parseRetryAfter(h: string | undefined, now: number): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * What to do with an upstream key after a failure. `streak` is the number of
 * consecutive failures including this one. Returns null when the key is not at fault.
 */
export function nextCooldown(
  cls: ErrorClass,
  streak: number,
  retryAfter: string | undefined,
  now: number,
): { status: KeyStatus; cooldownUntil?: number } | null {
  switch (cls) {
    case 'rate_limited': {
      const ms = parseRetryAfter(retryAfter, now) ?? COOLDOWN.rateLimitBaseMs * 2 ** Math.max(0, streak - 1);
      return { status: 'cooldown', cooldownUntil: now + Math.min(ms, COOLDOWN.maxMs) };
    }
    case 'server_error':
      return { status: 'cooldown', cooldownUntil: now + COOLDOWN.serverErrorMs };
    case 'auth_error':
      return { status: 'invalid' };
    default:
      return null;
  }
}
