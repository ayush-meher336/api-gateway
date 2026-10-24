import type { Repos } from '../db/repos/index.js';
import type { Model, ModelAlias, Provider, UpstreamKey } from '../db/types.js';

/** In-memory copy of the routing config. Rebuilt after admin writes; key status is refreshed live. */
export interface ConfigSnapshot {
  providers: Map<number, Provider>;
  providersByName: Map<string, Provider>;
  models: Map<number, Model>;
  aliasesByName: Map<string, ModelAlias>;
  keys: Map<number, UpstreamKey>;
  keysByProvider: Map<number, UpstreamKey[]>;
}

export function loadSnapshot(repos: Repos): ConfigSnapshot {
  const providers = repos.providers.list();
  const keys = repos.upstreamKeys.list();
  const keysByProvider = new Map<number, UpstreamKey[]>();
  for (const k of keys) {
    const arr = keysByProvider.get(k.providerId) ?? [];
    arr.push(k);
    keysByProvider.set(k.providerId, arr);
  }
  return {
    providers: new Map(providers.map((p) => [p.id, p])),
    providersByName: new Map(providers.map((p) => [p.name.toLowerCase(), p])),
    models: new Map(repos.models.list().map((m) => [m.id, m])),
    aliasesByName: new Map(repos.aliases.list().map((a) => [a.name, a])),
    keys: new Map(keys.map((k) => [k.id, k])),
    keysByProvider,
  };
}

/** Holds the current snapshot; admin routes call invalidate() after writes. */
export class SnapshotStore {
  private snap: ConfigSnapshot | null = null;
  constructor(private repos: Repos) {}
  get(): ConfigSnapshot {
    return (this.snap ??= loadSnapshot(this.repos));
  }
  invalidate(): void {
    this.snap = null;
  }
  /** Patch one key in place (status changes from the proxy) without a full reload. */
  updateKey(id: number, patch: Partial<UpstreamKey>): void {
    const k = this.snap?.keys.get(id);
    if (k) Object.assign(k, patch);
  }
}
