import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssetKeyError,
  assetStorageKey,
  isWorkspaceKey,
  sanitizeFileName,
} from '../../src/server/services/assets/asset-storage';
import { createLocalAssetStorage } from '../../src/server/services/assets/local-asset-storage';

const WS = 'ws_01K0000000000000000000000A';
const storageKey = `${WS}/ast_1/song.mp3`;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('asset storage keys (AST-001)', () => {
  it('sanitizes file names: no separators, traversal or control characters, a safe extension', () => {
    const cases = [
      ['../../etc/passwd', 'passwd'],
      ['..\\..\\Windows\\evil.EXE', 'evil.exe'],
      ['My Song (Final).MP3', 'My-Song-Final.mp3'],
      ['a\u0000b\u001f.wav\u202e', 'a-b.wav'],
      ['Café Été.flac', 'Cafe-Ete.flac'],
      ['...', 'file'],
      ['.htaccess', 'htaccess'],
      [`${'x'.repeat(300)}.mp3`, `${'x'.repeat(100)}.mp3`],
    ];
    for (const [name, expected] of cases) {
      expect(assetStorageKey(WS, 'ast_1', name), name).toBe(`${WS}/ast_1/${expected}`);
    }
    expect(sanitizeFileName('')).toBe('file');
    expect(() => assetStorageKey('ws_1/..', 'ast_1', 'a.mp3')).toThrow(AssetKeyError);
  });

  it('accepts only <workspaceId>/<assetId>/<file name> in safe segments', () => {
    expect(isWorkspaceKey(WS, storageKey)).toBe(true);
    const refused = [
      `${WS}B/ast_1/song.mp3`,
      `ast_1/${WS}/song.mp3`,
      `${WS}/../ws_other`,
      `${WS}/ast_1/..`,
      `${WS}/ast_1/.song.mp3.type`,
      `${WS}/ast_1\\..\\song.mp3`,
      `${WS}//song.mp3`,
      `${WS}/ast_1/song.mp3/x`,
      `/${WS}/ast_1/song.mp3`,
      `${WS}/ast_1/song\u0000.mp3`,
    ];
    for (const key of refused) expect(isWorkspaceKey(WS, key), key).toBe(false);
  });
});

describe('LocalAssetStorage URLs', () => {
  const secret = 'unit-test-secret-value-that-is-long-enough';
  const storage = createLocalAssetStorage({ rootDir: 'data/unit-assets', authSecret: secret });
  const queryOf = (url: string) => {
    const query = new URL(url, 'http://localhost').searchParams;
    return { expires: query.get('expires'), signature: query.get('signature') };
  };

  it('signs the method, key, content type and expiry, and refuses the URL once expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const input = { workspaceId: WS, storageKey, contentType: 'audio/mpeg', expiresInSeconds: 900 };
    const { url } = await storage.createUploadUrl(input);
    expect(url.startsWith(`/api/assets/local/${storageKey}?expires=`)).toBe(true);
    const put = { method: 'PUT', storageKey, contentType: 'audio/mpeg', ...queryOf(url) } as const;
    expect(storage.verifyUrl(put)).toBe('valid');
    for (const changed of [
      { method: 'GET' },
      { contentType: 'text/html' },
      { storageKey: `${WS}/ast_2/song.mp3` },
      { expires: String(Number(put.expires) + 3600) },
      { signature: null },
    ] as const) {
      expect(storage.verifyUrl({ ...put, ...changed }), JSON.stringify(changed)).toBe(
        'invalid-signature',
      );
    }
    vi.setSystemTime(Date.now() + 899_000);
    expect(storage.verifyUrl(put)).toBe('valid');
    vi.setSystemTime(Date.now() + 1_000);
    expect(storage.verifyUrl(put)).toBe('expired');
    const tooLong = { workspaceId: WS, storageKey, expiresInSeconds: 604_801 };
    await expect(storage.createDownloadUrl(tooLong)).rejects.toThrow(RangeError);
  });
});
