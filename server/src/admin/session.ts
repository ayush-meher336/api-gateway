import { randomBytes } from 'node:crypto';

const TTL_MS = 7 * 24 * 3_600_000;
const LOGIN_WINDOW_MS = 60_000;
const MAX_FAILURES = 5;

export const SESSION_COOKIE = 'gw_session';

/** In-memory admin sessions (single admin; restarting the gateway logs you out). */
export class SessionStore {
  private sessions = new Map<string, number>();
  private failures = new Map<string, number[]>();

  create(): { token: string; maxAgeS: number } {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + TTL_MS);
    return { token, maxAgeS: TTL_MS / 1000 };
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  destroyAll(): void {
    this.sessions.clear();
  }

  /** True when this IP has used up its login attempts for the current minute. */
  loginBlocked(ip: string): boolean {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const arr = (this.failures.get(ip) ?? []).filter((t) => t > cutoff);
    this.failures.set(ip, arr);
    return arr.length >= MAX_FAILURES;
  }

  recordFailure(ip: string): void {
    const arr = this.failures.get(ip) ?? [];
    arr.push(Date.now());
    this.failures.set(ip, arr);
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip);
  }
}
