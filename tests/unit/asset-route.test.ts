import { expect, it, vi } from 'vitest';

const resolve = vi.hoisted(() => vi.fn());
vi.mock('../../src/server/services/tenant-context', () => ({ tenantContextResolver: { resolve } }));

it('builds asset storage on the first asset call, which fails clearly while r2 is selected (D-7)', async () => {
  vi.stubEnv('MELOS_ASSET_STORAGE', 'r2');
  const selection = await import('../../src/server/services/assets/get-asset-storage');
  expect(selection.getLocalAssetStorage()).toBeNull();
  expect(() => selection.getAssetStorage()).toThrow(selection.AssetStorageUnavailableError);

  // The local route answers 404 before any session lookup where local storage is not selected.
  const route = await import('../../src/app/api/assets/local/[...key]/route');
  const key = ['ws_01K0000000000000000000000A', 'ast_1', 'song.mp3'];
  const request = new Request(`http://localhost:3100/api/assets/local/${key.join('/')}`);
  expect((await route.GET(request, { params: Promise.resolve({ key }) })).status).toBe(404);
  expect(resolve).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
