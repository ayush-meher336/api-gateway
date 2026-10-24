import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, DecryptError } from '../src/crypto/secretBox.js';
import { generateGatewayKey, hashGatewayKey, hashPassword, verifyPassword } from '../src/crypto/gatewayKey.js';

const key = randomBytes(32);

describe('secretBox', () => {
  it('roundtrips', () => {
    expect(decrypt(encrypt('sk-abc', key), key)).toBe('sk-abc');
  });
  it('produces distinct ciphertexts for the same input', () => {
    expect(encrypt('x', key)).not.toBe(encrypt('x', key));
  });
  it('tampered blob throws DecryptError', () => {
    const b = Buffer.from(encrypt('sk-abc', key), 'base64');
    b[b.length - 1] ^= 1;
    expect(() => decrypt(b.toString('base64'), key)).toThrow(DecryptError);
  });
  it('wrong master key throws DecryptError', () => {
    expect(() => decrypt(encrypt('sk-abc', key), randomBytes(32))).toThrow(DecryptError);
  });
  it('garbage input throws DecryptError', () => {
    expect(() => decrypt('nope', key)).toThrow(DecryptError);
  });
});

describe('gateway keys', () => {
  it('generates well-formed keys with prefix and hash', () => {
    const k = generateGatewayKey();
    expect(k.plain).toMatch(/^gw-[A-Za-z0-9]{40}$/);
    expect(k.prefix).toBe(k.plain.slice(0, 10));
    expect(k.hash).toBe(hashGatewayKey(k.plain));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generateGatewayKey().plain).not.toBe(k.plain);
  });
});

describe('passwords', () => {
  it('verifies correct and rejects wrong', () => {
    const h = hashPassword('correct horse');
    expect(verifyPassword('correct horse', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
    expect(verifyPassword('x', 'malformed')).toBe(false);
  });
});
