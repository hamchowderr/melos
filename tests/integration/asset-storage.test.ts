import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { AssetKeyError, assetStorageKey } from '../../src/server/services/assets/asset-storage';
import { createLocalAssetStorage } from '../../src/server/services/assets/local-asset-storage';

const ROOT = 'data/test-asset-storage';
const ALPHA = 'ws_01K0000000000000000000000A';
const BETA = 'ws_01K0000000000000000000000B';
const authSecret = 'vitest-only-placeholder-not-a-real-secret';
const storage = createLocalAssetStorage({ rootDir: ROOT, authSecret });
const key = assetStorageKey(ALPHA, 'ast_01K0000000000000000000000A', '../My Song.MP3');
const bytes = (text: string) => new TextEncoder().encode(text);

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  const body = bytes('alpha audio');
  await storage.put({ workspaceId: ALPHA, storageKey: key, contentType: 'audio/mpeg', body });
});

describe('AST-INT-001: LocalAssetStorage keeps a key inside the workspace that generated it', () => {
  it('stores, reads and deletes objects under the workspace prefix', async () => {
    expect(key).toBe(`${ALPHA}/ast_01K0000000000000000000000A/My-Song.mp3`);
    const object = await storage.read({ workspaceId: ALPHA, storageKey: key });
    expect([Buffer.from(object?.body ?? []).toString(), object?.contentType]).toEqual([
      'alpha audio',
      'audio/mpeg',
    ]);
    const other = { workspaceId: ALPHA, storageKey: `${ALPHA}/ast_2/other.wav` };
    await storage.put({ ...other, contentType: 'audio/wav', body: bytes('other') });
    expect(await storage.head(other)).toEqual({ contentType: 'audio/wav', size: 5 });
    // A replaced object: the new bytes and type, and no temporary file left beside it.
    await storage.put({ ...other, contentType: 'audio/x-wav', body: bytes('longer') });
    expect(await storage.head(other)).toEqual({ contentType: 'audio/x-wav', size: 6 });
    expect(readdirSync(dirname(join(ROOT, other.storageKey))).sort()).toEqual([
      '.other.wav.type',
      'other.wav',
    ]);
    await storage.delete(other);
    expect(await storage.read(other)).toBeNull();
    expect(await storage.head(other)).toBeNull();
  });

  it('refuses workspace A keys in workspace B from every method, touching no file', async () => {
    const inBeta = { workspaceId: BETA, storageKey: key };
    const methods = [
      () => storage.createUploadUrl({ ...inBeta, contentType: 'text/html', expiresInSeconds: 900 }),
      () => storage.createDownloadUrl({ ...inBeta, expiresInSeconds: 300 }),
      () => storage.put({ ...inBeta, contentType: 'text/html', body: bytes('beta') }),
      () => storage.delete(inBeta),
      () => storage.read(inBeta),
      () => storage.head(inBeta),
    ];
    for (const method of methods) await expect(method()).rejects.toThrow(AssetKeyError);

    // Traversal inside a workspace's own prefix, including Windows separators.
    for (const storageKey of [`${ALPHA}/../${BETA}`, `${ALPHA}/ast_1\\..\\..\\${BETA}`]) {
      const body = bytes('beta');
      const put = storage.put({ workspaceId: ALPHA, storageKey, contentType: 'text/html', body });
      await expect(put, storageKey).rejects.toThrow(AssetKeyError);
    }
    expect(readFileSync(join(ROOT, key), 'utf8')).toBe('alpha audio');
    expect(existsSync(join(ROOT, BETA))).toBe(false);
  });
});
