import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
import { z } from 'zod';

export interface Env {
  host: string;
  port: number;
  dataDir: string;
  masterKey: Buffer;
  logLevel: string;
}

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.string().default('info'),
});

/** Loads .env (writing a fresh master key on first run) and validates it. */
export function loadEnv(envFile = resolve(process.cwd(), '.env')): Env {
  dotenv({ path: envFile, quiet: true } as any);
  let key = process.env.GATEWAY_MASTER_KEY?.trim();
  if (!key) {
    key = randomBytes(32).toString('hex');
    const line = `GATEWAY_MASTER_KEY=${key}`;
    const txt = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    const next = /^GATEWAY_MASTER_KEY=.*$/m.test(txt)
      ? txt.replace(/^GATEWAY_MASTER_KEY=.*$/m, line)
      : txt + (txt && !txt.endsWith('\n') ? '\n' : '') + line + '\n';
    writeFileSync(envFile, next);
    process.env.GATEWAY_MASTER_KEY = key;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('GATEWAY_MASTER_KEY must be 64 hex characters');
  const parsed = schema.parse(process.env);
  return {
    host: parsed.HOST,
    port: parsed.PORT,
    dataDir: resolve(parsed.DATA_DIR),
    masterKey: Buffer.from(key, 'hex'),
    logLevel: parsed.LOG_LEVEL,
  };
}
