import { getServerEnv } from '../../env';
import type { AssetStorage } from './asset-storage';
import { createLocalAssetStorage, type LocalAssetStorage } from './local-asset-storage';
import { createR2AssetStorage } from './r2-asset-storage';

/**
 * Thrown by the asset call itself, never at startup, while R2 is selected and its variables are
 * missing. It names the variables, never their values (ADR-031).
 */
export class AssetStorageUnavailableError extends Error {
  readonly code = 'R2_NOT_CONFIGURED';

  constructor(readonly missing: string[]) {
    super(`Asset storage is unavailable: set ${missing.join(', ')} to use R2`);
    this.name = 'AssetStorageUnavailableError';
  }
}

let local: LocalAssetStorage | undefined;
let r2: AssetStorage | undefined;

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
  const files = getLocalAssetStorage();
  if (files) return files;
  const { assetStorage } = getServerEnv();
  if (assetStorage.kind === 'r2' && 'config' in assetStorage) {
    r2 ??= createR2AssetStorage(assetStorage.config);
    return r2;
  }
  throw new AssetStorageUnavailableError('missing' in assetStorage ? assetStorage.missing : []);
}
