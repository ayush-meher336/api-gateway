import type { Db } from '../client.js';
import type { Provider } from '../types.js';
import { table } from './table.js';

export type ProviderInput = Pick<Provider, 'name' | 'type' | 'baseUrl'> & Partial<Omit<Provider, 'id' | 'createdAt'>>;

export function providersRepo(db: Db) {
  const t = table<Provider>(db, 'providers', { extraHeaders: 'json', enabled: 'bool' });
  return {
    list: () => t.list('ORDER BY priority, id'),
    get: t.get,
    create(input: ProviderInput): Provider {
      return t.get(t.insert({ ...input, createdAt: Date.now() }))!;
    },
    update(id: number, patch: Partial<ProviderInput>): Provider {
      t.update(id, patch);
      return t.get(id)!;
    },
    delete: t.delete,
  };
}
