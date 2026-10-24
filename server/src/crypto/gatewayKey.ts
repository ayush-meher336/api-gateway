import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function randomBase62(len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += BASE62[randomInt(62)];
  return s;
}

export function hashGatewayKey(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function generateGatewayKey(): { plain: string; hash: string; prefix: string } {
  const plain = 'gw-' + randomBase62(40);
  return { plain, hash: hashGatewayKey(plain), prefix: plain.slice(0, 10) };
}

/** Stored as `scrypt$<salt hex>$<hash hex>`. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(pw, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}
