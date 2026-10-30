import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let deletes: typeof import('../../src/server/services/catalog/deletes');
let compositions: typeof import('../../src/server/services/catalog/compositions');
let recordings: typeof import('../../src/server/services/catalog/recordings');
let releases: typeof import('../../src/server/services/catalog/releases');
let read: typeof import('../../src/server/services/catalog/read');
let search: typeof import('../../src/server/services/catalog/search');
let owner: TenantContext;
const { auditLog } = tables;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });

beforeAll(async () => {
  services = await prepareWorkspaceServices('catalog-deletes');
  deletes = await import('../../src/server/services/catalog/deletes');
  compositions = await import('../../src/server/services/catalog/compositions');
  recordings = await import('../../src/server/services/catalog/recordings');
  releases = await import('../../src/server/services/catalog/releases');
  read = await import('../../src/server/services/catalog/read');
  search = await import('../../src/server/services/catalog/search');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

const auditsOf = async (entityId: string) =>
  (await open(owner)).select().from(auditLog).where(eq(auditLog.entityId, entityId));

async function consistent() {
  const database = await open(owner);
  const index = await catalogSearchOf(database);
  expect(index.indexed).toEqual(index.derived);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

async function accepted<T>(
  pending: Promise<{ ok: true; value: T } | { ok: false; error: object }>,
) {
  const result = await pending;
  if (!result.ok) throw new Error(`Refused with ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('melos-rpr.24: soft-delete songs, recordings and releases (§6.2, D-11)', () => {
  it('deletes an unreferenced song: gone from the list and search, its ISWC free again', async () => {
    const iswc = 'T-034.524.680-1';
    const song = await accepted(
      compositions.createComposition(owner, { title: 'Glass Harbor', iswc }),
    );
    const id = song.focus.entityId;
    expect(await deletes.deleteComposition(owner, id)).toEqual({
      ok: true,
      value: { entityType: 'composition', entityId: id },
    });
    const listed = await accepted(read.listSongs(owner));
    expect(listed.some((s) => s.compositionId === id)).toBe(false);
    expect(await accepted(search.searchMusic(owner, { query: 'Glass Harbor' }))).toEqual([]);
    const [audit, ...more] = (await auditsOf(id)).filter((row) => row.action.endsWith('.delete'));
    expect(more).toEqual([]);
    expect(audit).toMatchObject({ action: 'composition.delete', actorUserId: owner.userId });
    expect(JSON.parse(audit.afterJson ?? '{}').deletedAt).not.toBeNull();
    await consistent();
    await accepted(compositions.createComposition(owner, { title: 'Glass Harbor II', iswc }));
    expect(await deletes.deleteComposition(owner, id)).toEqual(refused({ code: 'NOT_FOUND' }));
  });

  it('refuses a referenced song or recording with counts and writes nothing', async () => {
    const midnight = await deletes.deleteComposition(owner, NORTHSTAR.keys.cmp_MIDNIGHT);
    if (midnight.ok || midnight.error.code !== 'REFERENCED') throw new Error('Not refused');
    expect(Object.keys(midnight.error.counts).sort()).toEqual([
      'composition_contributors',
      'publishing_interests',
      'recordings',
    ]);
    // Midnight Drive's pitch items and master shares name its recording.
    const master = await deletes.deleteRecording(owner, NORTHSTAR.keys.rec_MIDNIGHT);
    if (master.ok || master.error.code !== 'REFERENCED') throw new Error('Not refused');
    expect(Object.keys(master.error.counts)).toEqual(
      expect.arrayContaining(['master_interests', 'pitch_items']),
    );
    const take = await accepted(recordings.createRecording(owner, { title: 'Single Take' }));
    const takeId = take.focus.entityId;
    const release = await accepted(
      releases.createRelease(owner, {
        title: 'Single',
        tracks: [{ recordingId: takeId, discNumber: 1, trackNumber: 1 }],
      }),
    );
    const audits = (await auditsOf(takeId)).length;
    expect(await deletes.deleteRecording(owner, takeId)).toEqual(
      refused({ code: 'REFERENCED', counts: { release_tracks: 1 } }),
    );
    expect(await auditsOf(takeId)).toHaveLength(audits);
    await consistent();
    expect((await deletes.deleteRelease(owner, release.id)).ok).toBe(true);
    expect((await auditsOf(release.id)).map((row) => row.action)).toContain('release.delete');
  });

  it('deletes a standalone recording and its own search row', async () => {
    const take = await accepted(recordings.createRecording(owner, { title: 'Loose Demo' }));
    const id = take.focus.entityId;
    expect((await deletes.deleteRecording(owner, id)).ok).toBe(true);
    const index = await catalogSearchOf(await open(owner));
    expect(JSON.stringify(index.indexed)).not.toContain('Loose Demo');
    await consistent();
  });

  it('refuses a member and a viewer before the database opens, and another workspace', async () => {
    services.getWorkspaceDatabase.mockClear();
    const forbidden = refused({ code: 'FORBIDDEN' });
    for (const role of ['member', 'viewer'] as const) {
      const tenant = withRole(owner, role);
      expect(await deletes.deleteComposition(tenant, NORTHSTAR.keys.cmp_HOME)).toEqual(forbidden);
      expect(await deletes.deleteRecording(tenant, NORTHSTAR.keys.rec_HOME)).toEqual(forbidden);
      expect(await deletes.deleteRelease(tenant, `rel_${ulid()}`)).toEqual(forbidden);
    }
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
    const other = await services.provision('owner');
    expect(await deletes.deleteRecording(other, NORTHSTAR.keys.rec_HOME)).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
  });
});
