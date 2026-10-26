import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { loadEnv } from './config/env.js';
import { openDb } from './db/client.js';
import { createServices } from './services.js';
import { buildApp } from './app.js';
import { applyPendingRestore } from './bootstrap.js';
import { pruneLogs } from './logging/retention.js';
import { readSettings } from './admin/settings.js';

const here = dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;

async function main() {
  const env = loadEnv(process.env.GATEWAY_ENV_FILE ?? resolve('.env'));
  const logger = pino({ level: env.logLevel });

  mkdirSync(env.dataDir, { recursive: true });
  const dbFile = join(env.dataDir, 'gateway.db');
  if (applyPendingRestore(env.dataDir, dbFile)) logger.warn({ dbFile }, 'restored database from staged backup');

  let db;
  try {
    db = openDb(dbFile);
  } catch (err) {
    logger.fatal({ err, dbFile }, 'could not open database');
    process.exit(1);
  }

  const s = createServices(db, env.masterKey, { logger });
  const app = buildApp(s, { logger, dataDir: env.dataDir, webDir: resolve(here, '../../web/dist') });
  s.logWriter.start();

  const prune = () => {
    try {
      const n = pruneLogs(db, readSettings(s.repos).retentionDays);
      if (n) logger.info({ deleted: n }, 'pruned old request logs');
    } catch (err) {
      logger.error({ err }, 'log pruning failed');
    }
  };
  prune();
  const pruneTimer = setInterval(prune, DAY);
  const cursorTimer = setInterval(() => {
    try {
      s.persistCursors();
    } catch (err) {
      logger.error({ err }, 'persisting round-robin cursors failed');
    }
    s.rateLimits.prune();
  }, 30_000);
  pruneTimer.unref();
  cursorTimer.unref();

  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => logger.error({ err }, 'uncaught exception'));

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      await app.close();
    } catch (err) {
      logger.error({ err }, 'error while closing server');
    }
    clearInterval(pruneTimer);
    clearInterval(cursorTimer);
    await s.logWriter.stop();
    try {
      s.persistCursors();
    } catch {
      /* best effort */
    }
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));

  try {
    await app.listen({ host: env.host, port: env.port });
  } catch (err) {
    logger.fatal({ err }, `could not listen on ${env.host}:${env.port}`);
    process.exit(1);
  }
  logger.info(`AI Gateway ready → dashboard http://${env.host}:${env.port}  ·  API base URL http://${env.host}:${env.port}/v1`);
}

void main();
