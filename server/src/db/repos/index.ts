import type { Db } from '../client.js';
import { providersRepo } from './providers.js';
import { upstreamKeysRepo } from './upstreamKeys.js';
import { modelsRepo } from './models.js';
import { aliasesRepo } from './aliases.js';
import { gatewayKeysRepo } from './gatewayKeys.js';
import { settingsRepo } from './settings.js';

export function createRepos(db: Db, masterKey: Buffer) {
  return {
    db,
    providers: providersRepo(db),
    upstreamKeys: upstreamKeysRepo(db, masterKey),
    models: modelsRepo(db),
    aliases: aliasesRepo(db),
    gatewayKeys: gatewayKeysRepo(db),
    settings: settingsRepo(db),
  };
}

export type Repos = ReturnType<typeof createRepos>;
export type { ModelInfo } from './models.js';
