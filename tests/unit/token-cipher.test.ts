import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTokenCipher, TokenCipherError } from '../../src/server/db/token-cipher';

const newKey = () => randomBytes(32).toString('base64');
const TOKEN = 'header.workspace-token-for-tests.signature';
const NAME = 'melos-ws-01KZ45MY00HZJQADWRJBP6554M';
const OTHER_NAME = 'melos-ws-01KZ45MY00HZJQADWRJBP6554N';

describe('createTokenCipher', () => {
  it('round-trips a token under a fresh IV without embedding it in the ciphertext', () => {
    const cipher = createTokenCipher(newKey());
    const ciphertext = cipher.encrypt(TOKEN, NAME);
    expect(ciphertext).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(ciphertext).not.toContain(TOKEN);
    expect(cipher.encrypt(TOKEN, NAME)).not.toBe(ciphertext);
    expect(cipher.decrypt(ciphertext, NAME)).toBe(TOKEN);
  });

  it('refuses a ciphertext altered by one byte, read with another key or for another database', () => {
    const cipher = createTokenCipher(newKey());
    const ciphertext = cipher.encrypt(TOKEN, NAME);
    const bytes = Buffer.from(ciphertext.slice('v1:'.length), 'base64url');
    // One byte of the IV, the auth tag and the encrypted token.
    for (const index of [0, 12, bytes.length - 1]) {
      const altered = Buffer.from(bytes);
      altered[index] ^= 1;
      expect(() => cipher.decrypt(`v1:${altered.toString('base64url')}`, NAME)).toThrow(
        'ciphertext failed authentication',
      );
    }
    expect(() => createTokenCipher(newKey()).decrypt(ciphertext, NAME)).toThrow(TokenCipherError);
    expect(() => cipher.decrypt(ciphertext, OTHER_NAME)).toThrow(TokenCipherError);
    expect(() => cipher.decrypt(`v2:${ciphertext.slice(3)}`, NAME)).toThrow(
      'unsupported ciphertext format',
    );
  });

  it('refuses a key that is not 32 bytes of base64 without printing it', () => {
    for (const key of [randomBytes(16).toString('base64'), `${newKey().slice(0, 43)}!`, '']) {
      expect(() => createTokenCipher(key)).toThrow(
        new TokenCipherError('key must be 32 bytes encoded as base64'),
      );
    }
  });
});
