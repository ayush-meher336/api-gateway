import { COOLDOWN } from '../router/cooldown.js';
import type { Repos } from '../db/repos/index.js';

export const SETTING_DEFAULTS = {
  retentionDays: 90,
  rateLimitCooldownMs: 30_000,
  serverErrorCooldownMs: 15_000,
  maxCooldownMs: 15 * 60_000,
  defaultMaxRetries: 3,
  defaultProviderTimeoutMs: 120_000,
};
export type GatewaySettings = typeof SETTING_DEFAULTS;

export function readSettings(repos: Repos): GatewaySettings {
  const out = { ...SETTING_DEFAULTS };
  for (const k of Object.keys(SETTING_DEFAULTS) as (keyof GatewaySettings)[]) out[k] = repos.settings.get(k, SETTING_DEFAULTS[k]);
  return out;
}

/** Pushes runtime-tunable settings into the modules that use them. */
export function applySettings(repos: Repos): GatewaySettings {
  const st = readSettings(repos);
  COOLDOWN.rateLimitBaseMs = st.rateLimitCooldownMs;
  COOLDOWN.serverErrorMs = st.serverErrorCooldownMs;
  COOLDOWN.maxMs = st.maxCooldownMs;
  return st;
}
