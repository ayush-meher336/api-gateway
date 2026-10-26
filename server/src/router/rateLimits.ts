/**
 * Short-lived 429 state, kept in memory. Providers often rate-limit a whole model (shared capacity),
 * not the key that happened to make the call, so a 429 must not bench the key for other models or
 * for long. Two layers:
 *  - key+model: the refused key skips only that model, briefly (Retry-After, else keyModelMs)
 *  - provider+model: when two different keys are refused for the same model within windowMs,
 *    the model is "busy" on that provider and is skipped entirely for modelPauseMs
 */
export interface RateLimitOptions {
  keyModelMs: number;
  modelPauseMs: number;
  windowMs: number;
  /** Cap for provider-supplied Retry-After. */
  maxMs: number;
}

export const RATE_LIMIT_DEFAULTS: RateLimitOptions = { keyModelMs: 15_000, modelPauseMs: 10_000, windowMs: 10_000, maxMs: 300_000 };

export class RateLimitTracker {
  private keyModel = new Map<string, number>();
  private modelPause = new Map<string, number>();
  private recent = new Map<string, { keyId: number; at: number }[]>();

  constructor(public opts: RateLimitOptions = { ...RATE_LIMIT_DEFAULTS }) {}

  /** Records a 429. `retryAfterMs` comes from the provider's Retry-After header when present. */
  record429(providerId: number, modelId: number, keyId: number, retryAfterMs: number | undefined, now = Date.now()): { modelPaused: boolean } {
    const wait = Math.min(retryAfterMs ?? this.opts.keyModelMs, this.opts.maxMs);
    this.keyModel.set(`${keyId}:${modelId}`, now + wait);

    const pm = `${providerId}:${modelId}`;
    const hits = (this.recent.get(pm) ?? []).filter((h) => h.at > now - this.opts.windowMs);
    hits.push({ keyId, at: now });
    this.recent.set(pm, hits);
    if (new Set(hits.map((h) => h.keyId)).size >= 2) {
      this.modelPause.set(pm, now + Math.min(Math.max(this.opts.modelPauseMs, retryAfterMs ?? 0), this.opts.maxMs));
      return { modelPaused: true };
    }
    return { modelPaused: false };
  }

  keyAllowed(keyId: number, modelId: number, now = Date.now()): boolean {
    return (this.keyModel.get(`${keyId}:${modelId}`) ?? 0) <= now;
  }

  modelPaused(providerId: number, modelId: number, now = Date.now()): boolean {
    return (this.modelPause.get(`${providerId}:${modelId}`) ?? 0) > now;
  }

  activePauses(now = Date.now()): { providerId: number; modelId: number; until: number }[] {
    return [...this.modelPause.entries()]
      .filter(([, until]) => until > now)
      .map(([k, until]) => {
        const [providerId, modelId] = k.split(':').map(Number);
        return { providerId, modelId, until };
      });
  }

  /** Drops expired entries so the maps stay small. */
  prune(now = Date.now()): void {
    for (const m of [this.keyModel, this.modelPause]) for (const [k, until] of m) if (until <= now) m.delete(k);
    for (const [k, hits] of this.recent) {
      const live = hits.filter((h) => h.at > now - this.opts.windowMs);
      if (live.length) this.recent.set(k, live);
      else this.recent.delete(k);
    }
  }

  get size(): number {
    return this.keyModel.size + this.modelPause.size + this.recent.size;
  }
}
