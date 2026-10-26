import { describe, it, expect } from 'vitest';
import { RateLimitTracker } from '../../src/router/rateLimits.js';

const P = 1;
const M = 10;
const OTHER_MODEL = 11;

describe('RateLimitTracker', () => {
  it('a 429 cools down only that key for that model, briefly', () => {
    const t = new RateLimitTracker({ keyModelMs: 15_000, modelPauseMs: 10_000, windowMs: 10_000, maxMs: 300_000 });
    t.record429(P, M, 1, undefined, 1000);
    expect(t.keyAllowed(1, M, 1000)).toBe(false);
    expect(t.keyAllowed(1, OTHER_MODEL, 1000)).toBe(true);
    expect(t.keyAllowed(2, M, 1000)).toBe(true);
    expect(t.keyAllowed(1, M, 1000 + 15_001)).toBe(true);
    expect(t.modelPaused(P, M, 1000)).toBe(false);
  });

  it('honours Retry-After up to the cap', () => {
    const t = new RateLimitTracker({ keyModelMs: 15_000, modelPauseMs: 10_000, windowMs: 10_000, maxMs: 60_000 });
    t.record429(P, M, 1, 40_000, 0);
    expect(t.keyAllowed(1, M, 39_000)).toBe(false);
    t.record429(P, M, 3, 999_000, 0);
    expect(t.keyAllowed(3, M, 60_001)).toBe(true);
  });

  it('a second distinct key refused on the same provider+model within the window pauses the model', () => {
    const t = new RateLimitTracker({ keyModelMs: 15_000, modelPauseMs: 10_000, windowMs: 10_000, maxMs: 300_000 });
    expect(t.record429(P, M, 1, undefined, 0).modelPaused).toBe(false);
    expect(t.record429(P, M, 1, undefined, 1000).modelPaused).toBe(false); // same key again: not evidence
    expect(t.record429(P, M, 2, undefined, 2000).modelPaused).toBe(true);
    expect(t.modelPaused(P, M, 2000)).toBe(true);
    expect(t.modelPaused(P, OTHER_MODEL, 2000)).toBe(false);
    expect(t.modelPaused(P, M, 2000 + 10_001)).toBe(false);
  });

  it('refusals further apart than the window do not pause the model', () => {
    const t = new RateLimitTracker({ keyModelMs: 15_000, modelPauseMs: 10_000, windowMs: 10_000, maxMs: 300_000 });
    t.record429(P, M, 1, undefined, 0);
    expect(t.record429(P, M, 2, undefined, 20_000).modelPaused).toBe(false);
  });

  it('lists active pauses for alerts and forgets expired ones', () => {
    const t = new RateLimitTracker({ keyModelMs: 15_000, modelPauseMs: 10_000, windowMs: 10_000, maxMs: 300_000 });
    t.record429(P, M, 1, undefined, 0);
    t.record429(P, M, 2, undefined, 0);
    expect(t.activePauses(5000)).toEqual([{ providerId: P, modelId: M, until: 10_000 }]);
    expect(t.activePauses(20_000)).toEqual([]);
    t.prune(1_000_000);
    expect(t.size).toBe(0);
  });
});
