import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  AssetKeyError,
  type AssetStorage,
  requireExpiry,
  requireWorkspaceKey,
} from './asset-storage';

/** Serves local URLs: src/app/api/assets/local/[...key]/route.ts. */
export const LOCAL_ASSET_ROUTE = '/api/assets/local';

type Method = 'GET' | 'PUT';
type KeyInput = { workspaceId: string; storageKey: string };

export type SignedUrlCheck = 'valid' | 'invalid-signature' | 'expired';

export type LocalAssetStorage = AssetStorage & {
  readonly provider: 'local';
  /** The stored bytes and content type, or null when no object has the key. */
  read(input: KeyInput): Promise<{ body: Uint8Array<ArrayBuffer>; contentType: string } | null>;
  /** Checks the query of a URL this storage signed: the signature first, then the expiry. */
  verifyUrl(input: {
    method: Method;
    storageKey: string;
    contentType: string;
    expires: string | null;
    signature: string | null;
  }): SignedUrlCheck;
};

/** Writes `data` to a hidden temporary file beside `file`, then renames it over `file`. */
async function replace(file: string, data: string | Uint8Array) {
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Development and tests (§7.5): objects under `rootDir` at their key, each with a hidden
 * `.<name>.type` file holding its content type, which no key can name. URLs point at the
 * authenticated local route and carry an HMAC-SHA256 signature over the method, key, content type
 * and expiry (PROPOSED), so they expire as R2 presigned URLs do.
 */
export function createLocalAssetStorage(options: {
  rootDir: string;
  authSecret: string;
}): LocalAssetStorage {
  const root = resolve(options.rootDir);
  // PROPOSED: a key derived from BETTER_AUTH_SECRET for this purpose only, so local URLs need no
  // new secret; local storage is refused on Vercel (D-7).
  const key = createHmac('sha256', options.authSecret).update('melos local asset url').digest();
  const sign = (...fields: string[]) =>
    createHmac('sha256', key).update(fields.join('\n')).digest('base64url');

  /** The object's files, refused unless the key resolves inside its workspace's folder. */
  function filesOf({ workspaceId, storageKey }: KeyInput) {
    requireWorkspaceKey(workspaceId, storageKey);
    const file = resolve(root, storageKey);
    if (!file.startsWith(resolve(root, workspaceId) + sep)) throw new AssetKeyError();
    return { file, typeFile: join(dirname(file), `.${basename(file)}.type`) };
  }

  function signedUrl(method: Method, input: KeyInput, contentType: string, seconds: number) {
    filesOf(input);
    requireExpiry(seconds);
    const expires = String(Math.floor(Date.now() / 1000) + seconds);
    const signature = sign(method, input.storageKey, contentType, expires);
    const query = new URLSearchParams({ expires, signature });
    return { url: `${LOCAL_ASSET_ROUTE}/${input.storageKey}?${query}` };
  }

  return {
    provider: 'local',
    async createUploadUrl({ contentType, expiresInSeconds, ...input }) {
      return signedUrl('PUT', input, contentType, expiresInSeconds);
    },
    async createDownloadUrl({ expiresInSeconds, ...input }) {
      return signedUrl('GET', input, '', expiresInSeconds);
    },
    async put({ contentType, body, ...input }) {
      const { file, typeFile } = filesOf(input);
      await mkdir(dirname(file), { recursive: true });
      // Each file is written beside its target and renamed over it, so a read never sees half a
      // file; the type goes first, so a new object's body never appears without it (melos-rpr.12).
      await replace(typeFile, contentType);
      await replace(file, body);
    },
    async delete(input) {
      const { file, typeFile } = filesOf(input);
      await Promise.all([rm(file, { force: true }), rm(typeFile, { force: true })]);
    },
    async head(input) {
      const { file, typeFile } = filesOf(input);
      try {
        const [{ size }, type] = await Promise.all([stat(file), readFile(typeFile, 'utf8')]);
        return { contentType: type || 'application/octet-stream', size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async read(input) {
      const { file, typeFile } = filesOf(input);
      try {
        const [body, type] = await Promise.all([readFile(file), readFile(typeFile, 'utf8')]);
        return { body, contentType: type || 'application/octet-stream' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    verifyUrl({ method, storageKey, contentType, expires, signature }) {
      const expected = Buffer.from(sign(method, storageKey, contentType, expires ?? ''));
      const given = Buffer.from(signature ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return 'invalid-signature';
      }
      return Number(expires) * 1000 > Date.now() ? 'valid' : 'expired';
    },
  };
}
