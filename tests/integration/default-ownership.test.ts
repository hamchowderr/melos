import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let service: typeof import('../../src/server/services/rights/default-ownership');
let songs: typeof import('../../src/server/services/catalog/songs');
let owner: TenantContext;
const { pty_JORDAN: JORDAN, pty_SILVERLINE: SILVERLINE, cmp_MIDNIGHT: MIDNIGHT } = NORTHSTAR.keys;

const auditCount = async () => {
  const database = await services.connections.getWorkspaceDatabase(owner.workspaceId);
  return (await database.select({ n: sql<number>`count(*)` }).from(tables.auditLog))[0].n;
};

beforeAll(async () => {
  services = await prepareWorkspaceServices('default-ownership');
  service = await import('../../src/server/services/rights/default-ownership');
  songs = await import('../../src/server/services/catalog/songs');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-rpr.36: proposeDefaultOwnership (RGT-008)', () => {
  it('proposes the self parties at 100% for a fresh song and writes nothing', async () => {
    const created = await songs.createSong(owner, {
      title: 'Fresh Song',
      altTitles: [],
      iswc: null,
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const { composition, recordings } = created.value;
    const before = await auditCount();
    const result = await service.proposeDefaultOwnership(withRole(owner, 'viewer'), {
      ...{ entityType: 'composition', entityId: composition?.id ?? '' },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value).toMatchObject({
      writerShares: [{ partyId: JORDAN, roles: ['songwriter'], shareBp: 10_000 }],
      publishingShares: { territory: 'WORLD', shares: [{ partyId: SILVERLINE, shareBp: 10_000 }] },
      masterShares: [
        { recordingId: recordings[0].id, shares: [{ partyId: SILVERLINE, shareBp: 10_000 }] },
      ],
      blockedReasons: [],
    });
    expect(await auditCount()).toBe(before);
  });

  it('leaves every side of a song with rows null, each with a reason', async () => {
    const result = await service.proposeDefaultOwnership(owner, {
      ...{ entityType: 'composition', entityId: MIDNIGHT },
    });
    expect(result).toMatchObject({
      ok: true,
      value: { writerShares: null, publishingShares: null, masterShares: null },
    });
    if (!result.ok) return;
    expect(result.value.blockedReasons).toEqual(
      ['writer', 'publishing', 'master'].map((side) => ({ side, code: 'has_rows' })),
    );
  });

  it('refuses an unknown song', async () => {
    const result = await service.proposeDefaultOwnership(owner, {
      ...{ entityType: 'composition', entityId: 'cmp_MISSING' },
    });
    expect(result).toEqual({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});
