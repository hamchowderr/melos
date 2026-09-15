/** Storage adapters for asset binaries, copied from docs/CONTRACT.md §7.5. */
export interface AssetStorage {
  readonly provider: 'local' | 'r2';
  createUploadUrl(input: {
    workspaceId: string;
    storageKey: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{ url: string }>;
  createDownloadUrl(input: {
    workspaceId: string;
    storageKey: string;
    expiresInSeconds: number;
  }): Promise<{ url: string }>;
  put(input: {
    workspaceId: string;
    storageKey: string;
    contentType: string;
    body: Uint8Array;
  }): Promise<void>;
  delete(input: { workspaceId: string; storageKey: string }): Promise<void>;
}

/** A storage key outside the tenant workspace's prefix or not in the generated shape (AST-001). */
export class AssetKeyError extends Error {
  readonly code = 'KEY_OUTSIDE_WORKSPACE';

  constructor() {
    super('Asset storage key is outside the workspace');
    this.name = 'AssetKeyError';
  }
}

/** One key segment: word characters, dots and dashes, starting and ending with a word character. */
const SEGMENT = /^\w(?:[\w.-]*\w)?$/;
const MAX_STEM = 100;

/**
 * A file name safe as the last key segment on every adapter: the base name only, accents dropped,
 * other characters outside `[A-Za-z0-9_.-]` collapsed to `-`, no `..`, and a short alphanumeric
 * extension kept in lower case. A name with nothing left becomes `file`.
 */
export function sanitizeFileName(fileName: string): string {
  const base = (fileName.split(/[/\\]/).pop() ?? '').normalize('NFKD').replace(/\p{M}/gu, '');
  const safe = base
    .replace(/[^\w.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  const dot = safe.lastIndexOf('.');
  const extension = dot > 0 && /^\.[A-Za-z0-9]{1,10}$/.test(safe.slice(dot)) ? safe.slice(dot) : '';
  const stem = safe.slice(0, extension ? dot : undefined).slice(0, MAX_STEM);
  return `${stem.replace(/[.-]+$/, '') || 'file'}${extension.toLowerCase()}`;
}

/** True only for `<workspaceId>/<assetId>/<file name>` in this workspace, each a safe segment. */
export function isWorkspaceKey(workspaceId: string, storageKey: string): boolean {
  const segments = storageKey.split('/');
  return (
    segments.length === 3 &&
    segments[0] === workspaceId &&
    segments.every((segment) => SEGMENT.test(segment))
  );
}

/** Every adapter method calls this first: a key from another workspace never reaches storage. */
export function requireWorkspaceKey(workspaceId: string, storageKey: string): void {
  if (!isWorkspaceKey(workspaceId, storageKey)) throw new AssetKeyError();
}

/** The key AssetService stores (§7.5, AST-001), from the workspace resolved for the request. */
export function assetStorageKey(workspaceId: string, assetId: string, fileName: string): string {
  const storageKey = `${workspaceId}/${assetId}/${sanitizeFileName(fileName)}`;
  requireWorkspaceKey(workspaceId, storageKey);
  return storageKey;
}
