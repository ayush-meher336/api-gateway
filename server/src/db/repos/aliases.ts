import { tx, type Db } from '../client.js';
import type { AliasTarget, ModelAlias } from '../types.js';
import { table } from './table.js';

export type TargetInput = Pick<AliasTarget, 'modelId'> & Partial<Pick<AliasTarget, 'weight' | 'priority' | 'enabled'>>;
export interface AliasInput {
  name: string;
  description?: string | null;
  enabled?: boolean;
  targets?: TargetInput[];
}

export function aliasesRepo(db: Db) {
  const a = table<Omit<ModelAlias, 'targets'>>(db, 'model_aliases', { enabled: 'bool' });
  const tg = table<AliasTarget>(db, 'alias_targets', { enabled: 'bool' });

  const withTargets = (al: Omit<ModelAlias, 'targets'> | null): ModelAlias | null =>
    al ? { ...al, targets: tg.list('WHERE alias_id = ? ORDER BY priority, id', al.id) } : null;

  const setTargets = (aliasId: number, targets: TargetInput[]) => {
    db.prepare('DELETE FROM alias_targets WHERE alias_id = ?').run(aliasId);
    for (const t of targets) tg.insert({ aliasId, weight: 1, priority: 0, enabled: true, ...t });
  };

  return {
    list: () => a.list('ORDER BY name').map((x) => withTargets(x)!),
    get: (id: number) => withTargets(a.get(id)),
    create(input: AliasInput): ModelAlias {
      return tx(db, () => {
        const { targets = [], ...rest } = input;
        const id = a.insert(rest);
        setTargets(id, targets);
        return withTargets(a.get(id))!;
      });
    },
    update(id: number, input: Partial<AliasInput>): ModelAlias {
      return tx(db, () => {
        const { targets, ...rest } = input;
        a.update(id, rest);
        if (targets) setTargets(id, targets);
        return withTargets(a.get(id))!;
      });
    },
    delete: a.delete,
  };
}
