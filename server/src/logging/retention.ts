import type { Db } from '../db/client.js';

/** Deletes raw request logs (and their attempts, via cascade) older than the retention window. Rollups are kept. */
export function pruneLogs(db: Db, retentionDays: number, now = Date.now()): number {
  const cutoff = now - retentionDays * 24 * 3_600_000;
  return Number(db.prepare('DELETE FROM request_logs WHERE ts < ?').run(cutoff).changes);
}
