import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { badRequest, type AdminContext } from '../context.js';
import { settingsUpdate } from '../schemas.js';
import { applySettings, readSettings } from '../settings.js';
import { exportConfig, importConfig } from '../configTransfer.js';

export const RESTORE_FILE = 'restore-pending.db';

export function settingsRoutes({ app, s, dataDir }: AdminContext) {
  app.get('/settings', async () => readSettings(s.repos));

  app.put('/settings', async (req) => {
    const body = settingsUpdate.parse(req.body);
    for (const [k, v] of Object.entries(body)) s.repos.settings.set(k, v);
    return applySettings(s.repos);
  });

  app.get('/settings/backup', async (_req, reply) => {
    const dir = join(tmpdir(), 'ai-gateway-backups');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `backup-${Date.now()}.db`);
    s.db.prepare('VACUUM INTO ?').run(file);
    const stream = createReadStream(file);
    stream.on('close', () => rmSync(file, { force: true }));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    reply.header('content-type', 'application/octet-stream').header('content-disposition', `attachment; filename="gateway-backup-${stamp}.db"`);
    return reply.send(stream);
  });

  /** Validates an uploaded backup and stages it; index.ts swaps it in on the next start. */
  app.post('/settings/restore', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('no_file', 'Upload a backup .db file');
    const buf = await file.toBuffer();
    if (buf.subarray(0, 15).toString() !== 'SQLite format 3') throw badRequest('invalid_backup', 'That file is not a SQLite database');
    const staged = join(dataDir, RESTORE_FILE);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(staged, buf);
    try {
      const probe = new DatabaseSync(staged, { readOnly: true });
      const v = probe.prepare('SELECT max(version) v FROM schema_migrations').get() as { v: number };
      probe.prepare('SELECT count(*) c FROM providers').get();
      probe.close();
      if (!v?.v) throw new Error('no schema');
    } catch {
      rmSync(staged, { force: true });
      throw badRequest('invalid_backup', 'That database is not a gateway backup');
    }
    return { ok: true, restartRequired: true, message: 'Backup staged. Restart the gateway to restore it.' };
  });

  app.get('/settings/restore', async () => ({ pending: existsSync(join(dataDir, RESTORE_FILE)) }));

  app.get('/config/export', async (req, reply) => {
    const { includeSecrets } = z.object({ includeSecrets: z.enum(['0', '1']).optional() }).parse(req.query);
    reply.header('content-disposition', 'attachment; filename="gateway-config.json"');
    return exportConfig(s.repos, includeSecrets === '1');
  });

  app.post('/config/import', async (req) => {
    try {
      const res = importConfig(s.repos, req.body);
      s.snapshots.invalidate();
      applySettings(s.repos);
      return res;
    } catch (err) {
      throw badRequest('import_failed', (err as Error).message);
    }
  });
}
