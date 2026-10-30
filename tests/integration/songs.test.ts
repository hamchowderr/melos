import { eq, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;

let services: Services;
let songs: typeof import('../../src/server/services/catalog/songs');
let owner: TenantContext;
const { auditLog, compositions, recordings } = tables;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);
const refused = (error: object) => ({ ok: false, error });

beforeAll(async () => {
  services = await prepareWorkspaceServices('songs');
  songs = await import('../../src/server/services/catalog/songs');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

/** Row counts that a refused createSong must leave alone. */
async function counts() {
  const database = await open(owner);
  const count = async (table: typeof compositions | typeof recordings | typeof auditLog) =>
    (await database.select({ n: sql<number>`count(*)` }).from(table))[0].n;
  return [await count(compositions), await count(recordings), await count(auditLog)];
}

describe('melos-rpr.33: createSong (CAT-001, D-10)', () => {
  it('writes a composition and its first recording with the same title, audited and indexed', async () => {
    const before = await counts();
    const result = await songs.createSong(withRole(owner, 'member'), {
      ...{ title: ' Test Song ', altTitles: ['Test'], iswc: null },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const song = result.value;
    expect(song.composition?.title).toBe('Test Song');
    expect(song.recordings.map(({ title }) => title)).toEqual(['Test Song']);
    const [cmp, rec, aud] = await counts();
    expect([cmp, rec, aud]).toEqual([before[0] + 1, before[1] + 1, before[2] + 2]);
    const database = await open(owner);
    const written = await database
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, song.recordings[0].id));
    expect(written.map(({ action }) => action)).toEqual(['recording.create']);
    const index = await catalogSearchOf(database);
    expect(index.indexed).toEqual(index.derived);
  });

  it('rolls back both rows when the recording side is refused, and refuses bad input first', async () => {
    const database = await open(owner);
    const [taken] = await database
      .select({ isrc: recordings.isrc })
      .from(recordings)
      .where(isNotNull(recordings.isrc))
      .limit(1);
    const before = await counts();
    // The composition is inserted first, then the taken ISRC refuses the recording.
    expect(await songs.createSong(owner, { title: 'Rollback', isrc: taken.isrc })).toEqual(
      refused({ code: 'CONFLICT', field: 'isrc' }),
    );
    expect(await songs.createSong(owner, { title: 'Bad', iswc: 'T-123' })).toMatchObject(
      refused({ code: 'INVALID_ISWC', field: 'iswc' }),
    );
    expect(await songs.createSong(owner, { title: ' ' })).toEqual(
      refused({ code: 'VALIDATION', field: 'title', reason: 'required' }),
    );
    expect(await counts()).toEqual(before);
    const rolledBack = await database
      .select()
      .from(compositions)
      .where(eq(compositions.title, 'Rollback'));
    expect(rolledBack).toEqual([]);
    expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });

  it('refuses a viewer before the database opens', async () => {
    services.getWorkspaceDatabase.mockClear();
    expect(await songs.createSong(withRole(owner, 'viewer'), { title: 'No' })).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
  });
});

describe('melos-rpr.33: deleteSong (CAT-001, §4.2)', () => {
  it('soft-deletes a song and its recordings in one audited write', async () => {
    const created = await songs.createSong(owner, { title: 'Short Lived' });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const {
      composition,
      recordings: [recording],
    } = created.value;
    const compositionId = composition?.id ?? '';
    expect(await songs.deleteSong(owner, compositionId)).toEqual({
      ok: true,
      value: { compositionId },
    });
    const database = await open(owner);
    const audits = await database
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(sql`${auditLog.entityId} IN (${compositionId}, ${recording.id})`);
    expect(audits.map(({ action }) => action).sort()).toEqual([
      'composition.create',
      'composition.delete',
      'recording.create',
      'recording.delete',
    ]);
    const [gone] = await database.select().from(recordings).where(eq(recordings.id, recording.id));
    expect(gone.deletedAt).not.toBeNull();
    const index = await catalogSearchOf(database);
    expect(index.indexed).toEqual(index.derived);
    expect(await songs.deleteSong(owner, compositionId)).toEqual(refused({ code: 'NOT_FOUND' }));
  });

  it('refuses a song whose recording is still in use, and writes nothing', async () => {
    const before = await counts();
    const midnight = await songs.deleteSong(owner, NORTHSTAR.keys.cmp_MIDNIGHT);
    if (midnight.ok || midnight.error.code !== 'REFERENCED') throw new Error('Not refused');
    expect(Object.keys(midnight.error.counts)).toEqual(
      expect.arrayContaining(['master_interests', 'pitch_items']),
    );
    expect(await counts()).toEqual(before);
    const database = await open(owner);
    const [live] = await database
      .select()
      .from(recordings)
      .where(eq(recordings.id, NORTHSTAR.keys.rec_MIDNIGHT));
    expect(live.deletedAt).toBeNull();
  });

  it('refuses a member before the database opens', async () => {
    services.getWorkspaceDatabase.mockClear();
    expect(await songs.deleteSong(withRole(owner, 'member'), 'cmp_ANY')).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
  });
});
