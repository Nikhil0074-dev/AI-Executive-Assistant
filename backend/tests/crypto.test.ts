import { describe, it, expect } from 'vitest';
import { decrypt, encrypt } from '../src/utils/crypto';

const KEY = '0'.repeat(63) + '1';
describe('token encryption', () => {
  it('round-trips and never stores plaintext', () => {
    const enc = encrypt('refresh-token-123', KEY);
    expect(enc).not.toContain('refresh-token-123');
    expect(decrypt(enc, KEY)).toBe('refresh-token-123');
  });
  it('uses a fresh IV each time', () => {
    expect(encrypt('x', KEY)).not.toBe(encrypt('x', KEY));
  });
  it('rejects tampered ciphertext and wrong keys', () => {
    const enc = encrypt('secret', KEY);
    const [iv, tag, data] = enc.split('.');
    const bad = [iv, tag, Buffer.from('tampered').toString('base64')].join('.');
    expect(() => decrypt(bad, KEY)).toThrow();
    expect(() => decrypt(enc, '1'.repeat(64))).toThrow();
    expect(data).toBeTruthy();
  });
  it('rejects invalid key length', () => {
    expect(() => encrypt('x', 'abcd')).toThrow(/32 bytes/);
  });
});
