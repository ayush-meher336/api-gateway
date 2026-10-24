import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class DecryptError extends Error {
  constructor() {
    super('decrypt_failed');
    this.name = 'DecryptError';
  }
}

/** AES-256-GCM; output is base64(iv[12] | tag[16] | ciphertext). */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(blob: string, key: Buffer): string {
  try {
    const b = Buffer.from(blob, 'base64');
    if (b.length < 29) throw new Error('short');
    const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new DecryptError();
  }
}
