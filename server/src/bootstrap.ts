import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RESTORE_FILE } from './admin/routes/settings.js';

/** If a restore was staged from the dashboard, move it into place (keeping the old db as .bak). */
export function applyPendingRestore(dataDir: string, dbFile: string): boolean {
  const staged = join(dataDir, RESTORE_FILE);
  if (!existsSync(staged)) return false;
  if (existsSync(dbFile)) renameSync(dbFile, `${dbFile}.bak-${Date.now()}`);
  for (const ext of ['-wal', '-shm']) rmSync(dbFile + ext, { force: true });
  renameSync(staged, dbFile);
  return true;
}
