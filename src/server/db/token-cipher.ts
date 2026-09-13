import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** True for 32 bytes as padded base64, such as the output of `openssl rand -base64 32`. */
export const isTokenKey = (value: string) => /^[A-Za-z0-9+/]{43}=$/.test(value);

/** A refused key or ciphertext. The message never contains a key, token or ciphertext. */
export class TokenCipherError extends Error {
  constructor(reason: string) {
    super(`Workspace token cipher: ${reason}`);
    this.name = 'TokenCipherError';
  }
}

export interface TokenCipher {
  /** Encrypts a workspace database token for `db_token_ciphertext` (P-08, ADR-031). */
  encrypt(token: string, databaseName: string): string;
  /** Decrypts a ciphertext made for the same database name, or throws TokenCipherError. */
  decrypt(ciphertext: string, databaseName: string): string;
}

/**
 * AES-256-GCM with a random IV. The database name is additional authenticated data, so a
 * ciphertext copied to another registry row does not decrypt. Stored as `v1:<base64url IV+tag+data>`.
 */
export function createTokenCipher(base64Key: string): TokenCipher {
  if (!isTokenKey(base64Key)) throw new TokenCipherError('key must be 32 bytes encoded as base64');
  const key = Buffer.from(base64Key, 'base64');

  return {
    encrypt(token, databaseName) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(databaseName));
      const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
    },
    decrypt(ciphertext, databaseName) {
      const [version, payload = ''] = ciphertext.split(':');
      const bytes = Buffer.from(payload, 'base64url');
      if (version !== VERSION || bytes.length < IV_BYTES + TAG_BYTES) {
        throw new TokenCipherError('unsupported ciphertext format');
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, IV_BYTES))
          .setAAD(Buffer.from(databaseName))
          .setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const data = bytes.subarray(IV_BYTES + TAG_BYTES);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        throw new TokenCipherError('ciphertext failed authentication');
      }
    },
  };
}
