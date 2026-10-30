import { and, eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import type { WorkspacePermissions } from '../../../lib/auth/permissions';
import {
  type AddAssetInput,
  ASSET_CONTENT_TYPES,
  ASSET_RELATIONSHIPS,
  ASSET_TYPES,
  type AssetDTO,
  type AssetLinkDTO,
  type AssetTargetType,
  type AssetType,
  MAX_ASSET_BYTES,
  type UploadInput,
  type UploadTicketDTO,
} from '../../../lib/dto/assets';
import {
  assets,
  compositionAssets,
  recordingAssets,
  releaseAssets,
} from '../../db/schema/workspace.generated';
import { workspaceIntegrityGuard as guard } from '../integrity-guard';
import { requirePermission } from '../permissions';
import { failure, type ServiceResult, success } from '../service-result';
import type { TenantContext } from '../tenant-context';
import { getWorkspaceDatabase, sanitized } from '../workspace-connections';
import { runWorkspaceWrite } from '../workspace-write';
import { ASSET_URL_SECONDS, assetStorageKey, downloadSeconds } from './asset-storage';
import { getAssetStorage } from './get-asset-storage';

const UPDATE: WorkspacePermissions = { catalog: ['update'] };
const READ: WorkspacePermissions = { catalog: ['read'] };

/** An id createUpload hands out; anything else can name no object. */
const ASSET_ID = /^ast_[0-9A-HJKMNP-TV-Z]{26}$/;

const refuse = (field: string, reason: string) => failure({ code: 'VALIDATION', field, reason });

function invalidUpload({ assetType, fileName, contentType }: UploadInput) {
  if (!ASSET_TYPES.includes(assetType)) return refuse('assetType', 'unknown_asset_type');
  if (!fileName?.trim()) return refuse('fileName', 'required');
  if (!ASSET_CONTENT_TYPES[assetType].includes(contentType))
    return refuse('contentType', 'not_allowed');
  return null;
}

/**
 * Starts an upload (§7.5, AST-001): the server generates the asset id and its key
 * `<workspaceId>/<assetId>/<sanitized file name>`, and signs a PUT for the P-35 upload lifetime.
 * No row is written and the database never opens; completeUpload registers the asset once the
 * object exists. catalog:update (D-5). The content type must be one the asset type accepts.
 */
export async function createUpload(
  tenant: TenantContext,
  input: UploadInput,
): Promise<ServiceResult<UploadTicketDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const invalid = invalidUpload(input);
  if (invalid) return invalid;
  const assetId = `ast_${ulid()}`;
  const { workspaceId } = tenant;
  const storageKey = assetStorageKey(workspaceId, assetId, input.fileName);
  const { contentType } = input;
  const expiresInSeconds = ASSET_URL_SECONDS.upload;
  const { url } = await getAssetStorage().createUploadUrl({
    ...{ workspaceId, storageKey, contentType, expiresInSeconds },
  });
  return success({ assetId, url, contentType, expiresInSeconds });
}

const toDTO = (row: typeof assets.$inferSelect): AssetDTO => ({
  id: row.id,
  assetType: row.assetType as AssetType,
  fileName: row.fileName,
  mimeType: row.mimeType ?? 'application/octet-stream',
  byteSize: row.byteSize ?? 0,
  createdAt: row.createdAt,
});

/**
 * Registers an uploaded object as an asset (§4.3) and audits asset.create (D-4). The key is derived
 * again from the tenant's workspace, the id and the file name, so an id from another workspace
 * names no object there and is NOT_FOUND, as is an upload that never landed. The stored type and
 * size come from storage, not the client: a type the asset type does not accept, or an object over
 * MAX_ASSET_BYTES, is VALIDATION. Completing the same asset twice is CONFLICT `assetId`.
 */
export async function completeUpload(
  tenant: TenantContext,
  input: { assetId: string } & Omit<UploadInput, 'contentType'>,
): Promise<ServiceResult<AssetDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const { assetId, assetType, fileName } = input;
  if (!ASSET_TYPES.includes(assetType)) return refuse('assetType', 'unknown_asset_type');
  if (!fileName?.trim()) return refuse('fileName', 'required');
  if (!ASSET_ID.test(assetId)) return failure('NOT_FOUND');
  const storage = getAssetStorage();
  const { workspaceId } = tenant;
  const storageKey = assetStorageKey(workspaceId, assetId, fileName);
  const object = await storage.head({ workspaceId, storageKey });
  if (!object) return failure('NOT_FOUND');
  if (!ASSET_CONTENT_TYPES[assetType].includes(object.contentType))
    return refuse('contentType', 'not_allowed');
  if (object.size > MAX_ASSET_BYTES) return refuse('byteSize', 'too_large');
  return runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const [held] = await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId));
    if (held) return failure({ code: 'CONFLICT', field: 'assetId' });
    const row = {
      ...{ id: assetId, assetType, storageProvider: storage.provider, storageKey },
      ...{ fileName: fileName.trim(), mimeType: object.contentType, byteSize: object.size },
      ...{ checksumSha256: null, createdAt: new Date().toISOString(), createdBy: tenant.userId },
    };
    await guard.insert(tx, assets, [row]);
    await audit.write({
      ...{ action: 'asset.create', entityType: 'asset', entityId: assetId },
      ...{ before: null, after: row },
    });
    return success(toDTO(row));
  });
}

const LINKS = {
  composition: {
    table: compositionAssets,
    key: 'compositionId',
    owner: compositionAssets.compositionId,
  },
  recording: { table: recordingAssets, key: 'recordingId', owner: recordingAssets.recordingId },
  release: { table: releaseAssets, key: 'releaseId', owner: releaseAssets.releaseId },
} as const;

/**
 * Attaches a registered asset to a composition, recording or release (CAT-005, §3.4 `addAsset`)
 * with a relationship that target's link table allows, and audits asset.attach (D-4). An unknown
 * asset, or a target with no live row in this workspace, is NOT_FOUND (the guard refuses a link to
 * a missing or soft-deleted parent). A link that already exists writes nothing.
 */
export async function addAsset(
  tenant: TenantContext,
  { assetId, target, relationship }: AddAssetInput,
): Promise<ServiceResult<AssetLinkDTO>> {
  if (!requirePermission(tenant, UPDATE).ok) return failure('FORBIDDEN');
  const entityType = (Object.keys(LINKS) as AssetTargetType[]).find(
    (type) => LINKS[type].key in target,
  );
  if (!entityType) return refuse('target', 'required');
  const { table, key, owner } = LINKS[entityType];
  const entityId = (target as Record<string, string>)[key];
  const allowed: readonly string[] = ASSET_RELATIONSHIPS[entityType];
  if (!allowed.includes(relationship)) return refuse('relationship', 'not_allowed');
  const link: AssetLinkDTO = { assetId, entityType, entityId, relationship };
  return runWorkspaceWrite(tenant, UPDATE, async (tx, audit) => {
    const [asset] = await tx.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId));
    if (!asset) return failure('NOT_FOUND');
    const same = and(
      eq(owner, entityId),
      eq(table.assetId, assetId),
      eq(table.relationship, relationship),
    );
    const [held] = await tx.select({ assetId: table.assetId }).from(table).where(same);
    if (held) return success(link);
    const row = { [key]: entityId, assetId, relationship } as typeof table.$inferInsert;
    await guard.insert(tx, table, [row]);
    await audit.write({
      ...{ action: 'asset.attach', entityType: 'asset', entityId: assetId },
      ...{ before: null, after: link },
    });
    return success(link);
  });
}

/**
 * A signed download URL for a registered asset (§7.5), valid for the P-35 lifetime of its type:
 * 3600 s for audio, 300 s otherwise. catalog:read. An id with no row in this workspace is NOT_FOUND.
 */
export async function getDownloadUrl(
  tenant: TenantContext,
  assetId: string,
): Promise<ServiceResult<{ url: string; expiresInSeconds: number }>> {
  if (!requirePermission(tenant, READ).ok) return failure('FORBIDDEN');
  const { workspaceId } = tenant;
  const [asset] = await sanitized(workspaceId, async () => {
    const database = await getWorkspaceDatabase(workspaceId);
    return database.select().from(assets).where(eq(assets.id, assetId));
  });
  if (!asset) return failure('NOT_FOUND');
  const expiresInSeconds = downloadSeconds(asset.mimeType ?? '');
  const { url } = await getAssetStorage().createDownloadUrl({
    ...{ workspaceId, storageKey: asset.storageKey, expiresInSeconds },
  });
  return success({ url, expiresInSeconds });
}
