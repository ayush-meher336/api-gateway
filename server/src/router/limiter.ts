const WINDOW_MS = 60_000;

interface Entry {
  ts: number;
  tokens: number;
}

export interface RateLimits {
  rpm?: number | null;
  tpm?: number | null;
}

/** In-memory sliding 60s windows for gateway keys ('gw') and upstream keys ('up'). */
export class KeyLimiter {
  private windows = new Map<string, Entry[]>();

  private entries(kind: 'gw' | 'up', id: number): Entry[] {
    const k = `${kind}:${id}`;
    let arr = this.windows.get(k);
    if (!arr) this.windows.set(k, (arr = []));
    const cutoff = Date.now() - WINDOW_MS;
    while (arr.length && arr[0].ts <= cutoff) arr.shift();
    return arr;
  }

  check(kind: 'gw' | 'up', id: number, limits: RateLimits): boolean {
    if (!limits.rpm && !limits.tpm) return true;
    const { requests, tokens } = this.countLast60s(kind, id);
    if (limits.rpm && requests >= limits.rpm) return false;
    if (limits.tpm && tokens >= limits.tpm) return false;
    return true;
  }

  record(kind: 'gw' | 'up', id: number, tokens: number): void {
    this.entries(kind, id).push({ ts: Date.now(), tokens });
  }

  /** Adds tokens to the most recent entry (usage is known only after the response). */
  addTokens(kind: 'gw' | 'up', id: number, tokens: number): void {
    const arr = this.entries(kind, id);
    if (arr.length) arr[arr.length - 1].tokens += tokens;
    else arr.push({ ts: Date.now(), tokens });
  }

  countLast60s(kind: 'gw' | 'up', id: number): { requests: number; tokens: number } {
    const arr = this.entries(kind, id);
    return { requests: arr.length, tokens: arr.reduce((s, e) => s + e.tokens, 0) };
  }
}
