import { getServerEnv } from '../../env';
import type { AssetStorage } from './asset-storage';
import { createLocalAssetStorage, type LocalAssetStorage } from './local-asset-storage';

/** Thrown by the asset call itself, never at startup, while MELOS_ASSET_STORAGE selects r2. */
export class AssetStorageUnavailableError extends Error {
  readonly code = 'R2_NOT_AVAILABLE';

  constructor() {
    super('Asset storage is unavailable: MELOS_ASSET_STORAGE selects r2, which is not built yet');
    this.name = 'AssetStorageUnavailableError';
  }
}

let local: LocalAssetStorage | undefined;

/** LocalAssetStorage when MELOS_ASSET_STORAGE selects local, built on first use; otherwise null. */
export function getLocalAssetStorage(): LocalAssetStorage | null {
  const { assetStorage, auth } = getServerEnv();
  if (assetStorage.kind !== 'local') return null;
  local ??= createLocalAssetStorage({ rootDir: assetStorage.rootDir, authSecret: auth.secret });
  return local;
}

/**
 * The adapter MELOS_ASSET_STORAGE selects, resolved on the first asset call so a deploy without
 * asset variables still serves every page (D-7).
 */
export function getAssetStorage(): AssetStorage {
  const storage = getLocalAssetStorage();
  if (!storage) throw new AssetStorageUnavailableError();
  return storage;
}
