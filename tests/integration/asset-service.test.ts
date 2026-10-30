import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { LocalAssetStorage } from '../../src/server/services/assets/local-asset-storage';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let assets: typeof import('../../src/server/services/assets/asset-service');
let owner: TenantContext;
let storage: LocalAssetStorage;
const { assets: assetRows, auditLog, recordingAssets, releaseAssets } = tables;
const { rec_OCEAN: OCEAN, cmp_OCEAN: OCEAN_SONG } = NORTHSTAR.keys;
const BYTES = new TextEncoder().encode('ID3 not really an mp3');
const AUDIO = {
  assetType: 'audio',
  fileName: 'Ocean Blue (Master).mp3',
  contentType: 'audio/mpeg',
};

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });

beforeAll(async () => {
  services = await prepareWorkspaceServices('asset-service');
  assets = await import('../../src/server/services/assets/asset-service');
  owner = await seedNorthstarTenant();
  const selection = await import('../../src/server/services/assets/get-asset-storage');
  storage = selection.getLocalAssetStorage() as LocalAssetStorage;
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

async function accepted<T>(
  pending: Promise<{ ok: true; value: T } | { ok: false; error: object }>,
) {
  const result = await pending;
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}

/** Puts the file at the ticket's key, as the browser's signed PUT does. */
async function upload(tenant: TenantContext, body = BYTES, input = AUDIO) {
  const ticket = await accepted(assets.createUpload(tenant, input as never));
  const path = decodeURIComponent(new URL(ticket.url, 'http://x').pathname);
  const storageKey = path.replace('/api/assets/local/', '');
  const { workspaceId } = tenant;
  await storage.put({ workspaceId, storageKey, contentType: input.contentType, body });
  return ticket;
}

async function auditCount(tenant: TenantContext) {
  return (await (await open(tenant)).select().from(auditLog)).length;
}

async function consistent(tenant = owner) {
  expect(await (await open(tenant)).all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

describe('melos-rpr.34: AssetService (CAT-005, AST-001)', () => {
  it('signs an upload without opening the database, then registers and attaches it', async () => {
    services.getWorkspaceDatabase.mockClear();
    const ticket = await upload(withRole(owner, 'member'));
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    expect(ticket).toMatchObject({ contentType: 'audio/mpeg', expiresInSeconds: 900 });
    expect(ticket.url).toContain(`${owner.workspaceId}/${ticket.assetId}/Ocean-Blue-Master.mp3`);
    const audits = await auditCount(owner);

    const asset = await accepted(
      assets.completeUpload(owner, { assetId: ticket.assetId, ...AUDIO } as never),
    );
    expect(asset).toMatchObject({ mimeType: 'audio/mpeg', byteSize: BYTES.length });
    const target = { recordingId: OCEAN };
    const link = { assetId: asset.id, target, relationship: 'audio_preview' };
    expect(await accepted(assets.addAsset(owner, link))).toEqual({
      ...{ assetId: asset.id, entityType: 'recording', entityId: OCEAN },
      relationship: 'audio_preview',
    });
    await accepted(assets.addAsset(owner, link));

    const database = await open(owner);
    const rows = await database.select().from(assetRows).where(eq(assetRows.id, asset.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].storageKey.startsWith(`${owner.workspaceId}/`)).toBe(true);
    const links = await database
      .select()
      .from(recordingAssets)
      .where(eq(recordingAssets.assetId, asset.id));
    expect(links).toHaveLength(1);
    const written = await database.select().from(auditLog).where(eq(auditLog.entityId, asset.id));
    expect(written.map((row) => row.action)).toEqual(['asset.create', 'asset.attach']);
    expect(written.every((row) => row.actorUserId === owner.userId && row.requestId)).toBe(true);
    expect(await auditCount(owner)).toBe(audits + 2);
    await consistent();

    const download = await accepted(assets.getDownloadUrl(withRole(owner, 'viewer'), asset.id));
    expect(download.expiresInSeconds).toBe(3600);
    expect(download.url).toContain(rows[0].storageKey);
  });

  it('refuses a missing object, a second completion, bad input and bad targets', async () => {
    const audits = await auditCount(owner);
    const ticket = await accepted(assets.createUpload(owner, AUDIO as never));
    const complete = { assetId: ticket.assetId, ...AUDIO } as never;
    expect(await assets.completeUpload(owner, complete)).toEqual(refused({ code: 'NOT_FOUND' }));
    expect(
      await assets.createUpload(owner, { ...AUDIO, contentType: 'text/html\r\nx: y' } as never),
    ).toEqual(refused({ code: 'VALIDATION', field: 'contentType', reason: 'not_allowed' }));
    expect(await assets.createUpload(owner, { ...AUDIO, assetType: 'video' } as never)).toEqual(
      refused({ code: 'VALIDATION', field: 'assetType', reason: 'unknown_asset_type' }),
    );

    const done = await upload(owner);
    const again = { assetId: done.assetId, ...AUDIO } as never;
    await accepted(assets.completeUpload(owner, again));
    expect(await assets.completeUpload(owner, again)).toEqual(
      refused({ code: 'CONFLICT', field: 'assetId' }),
    );
    const image = await upload(owner, BYTES, { ...AUDIO, assetType: 'other' });
    expect(
      await assets.completeUpload(owner, {
        assetId: image.assetId,
        ...AUDIO,
        assetType: 'image',
      } as never),
    ).toEqual(refused({ code: 'VALIDATION', field: 'contentType', reason: 'not_allowed' }));

    const art = { assetId: done.assetId, target: { compositionId: OCEAN_SONG } };
    expect(await assets.addAsset(owner, { ...art, relationship: 'cover_art' })).toEqual(
      refused({ code: 'VALIDATION', field: 'relationship', reason: 'not_allowed' }),
    );
    const missing = { assetId: done.assetId, target: { releaseId: 'rel_missing' } };
    expect(await assets.addAsset(owner, { ...missing, relationship: 'cover_art' })).toMatchObject(
      refused({ code: 'NOT_FOUND' }),
    );
    expect(
      await assets.addAsset(owner, { ...art, assetId: 'ast_missing', relationship: 'lead_sheet' }),
    ).toEqual(refused({ code: 'NOT_FOUND' }));
    expect(await (await open(owner)).select().from(releaseAssets)).toEqual([]);
    expect(await auditCount(owner)).toBe(audits + 1);
    await consistent();
  });

  it('refuses a viewer before the database opens and keeps workspaces apart', async () => {
    const viewer = withRole(owner, 'viewer');
    services.getWorkspaceDatabase.mockClear();
    expect(await assets.createUpload(viewer, AUDIO as never)).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(
      await assets.addAsset(viewer, {
        ...{ assetId: 'ast_x', target: { recordingId: OCEAN }, relationship: 'other' },
      }),
    ).toEqual(refused({ code: 'FORBIDDEN' }));
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();

    const ticket = await upload(owner);
    const asset = await accepted(
      assets.completeUpload(owner, { assetId: ticket.assetId, ...AUDIO } as never),
    );
    const other = await services.provision('owner');
    expect(
      await assets.completeUpload(other, { assetId: ticket.assetId, ...AUDIO } as never),
    ).toEqual(refused({ code: 'NOT_FOUND' }));
    expect(await assets.getDownloadUrl(other, asset.id)).toEqual(refused({ code: 'NOT_FOUND' }));
    const link = { assetId: asset.id, target: { recordingId: OCEAN }, relationship: 'other' };
    expect(await assets.addAsset(other, link)).toEqual(refused({ code: 'NOT_FOUND' }));
    await consistent(other);
  });
});
