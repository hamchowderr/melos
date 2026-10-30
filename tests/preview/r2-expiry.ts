import { createR2AssetStorage } from '../../src/server/services/assets/r2-asset-storage';

/**
 * Records the status R2 answers for an expired presigned GET (U-27): signs a 1-second URL for a
 * key under NORTHSTAR_WORKSPACE_ID, waits 3 seconds, and prints the status only, never the URL.
 * Run with the preview's R2_* variables: npx tsx tests/preview/r2-expiry.ts <storageKey>
 */
const [storageKey] = process.argv.slice(2);
const workspaceId = process.env.NORTHSTAR_WORKSPACE_ID ?? '';
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
if (!storageKey) throw new Error('Pass the storage key the preview spec logged.');

const storage = createR2AssetStorage({
  accountId: env('R2_ACCOUNT_ID'),
  accessKeyId: env('R2_ACCESS_KEY_ID'),
  secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  bucket: env('R2_BUCKET'),
});
const { url } = await storage.createDownloadUrl({ workspaceId, storageKey, expiresInSeconds: 1 });
const fresh = await fetch(url);
await new Promise((resolve) => setTimeout(resolve, 3_000));
const expired = await fetch(url);
console.log(`fresh ${fresh.status}, expired ${expired.status}`);
