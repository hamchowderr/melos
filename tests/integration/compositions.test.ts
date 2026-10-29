import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import type { WorkspaceTransaction } from '../../src/server/services/workspace-write';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices, withRole } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type SearchIndex = typeof import('../../src/server/services/catalog/search-index');
type Compositions = typeof import('../../src/server/services/catalog/compositions');

const AT = '2026-09-15T12:00:00.000Z';
let services: Services;
let searchIndex: SearchIndex;
let service: Compositions;
let owner: TenantContext;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);

beforeAll(async () => {
  services = await prepareWorkspaceServices('compositions');
  searchIndex = await import('../../src/server/services/catalog/search-index');
  service = await import('../../src/server/services/catalog/compositions');
  owner = await seedNorthstarTenant();
});

afterAll(async () => {
  if (owner) await services.connections.closeWorkspaceDatabase(owner.workspaceId);
  await services?.close();
});

describe('melos-rpr.13: catalog_search and duplicate compositions (CAT-001)', () => {
  it("re-derives one song's catalog_search rows in the caller's transaction, as validate.mjs derives the whole catalog (§4.3)", async () => {
    const database = await open(owner);
    const seeded = await catalogSearchOf(database);
    expect(seeded.indexed).toEqual(seeded.derived);
    // Paper Planes at 2AM: an alternate title, and a recording with artists.
    const paper = NORTHSTAR.keys.cmp_PAPER;
    const { compositions, compositionAltTitles, recordings } = tables;
    const [song, takes] = [eq(compositions.id, paper), eq(recordings.compositionId, paper)];
    const edits: ((tx: WorkspaceTransaction) => Promise<void>)[] = [
      async (tx) => {
        await tx.update(compositions).set({ title: 'Paper Planes', lyrics: 'Fold' }).where(song);
        const planes = { id: ulid(), compositionId: paper, title: 'Planes' };
        await tx.insert(compositionAltTitles).values(planes);
        await tx.update(recordings).set({ versionTitle: 'Acoustic' }).where(takes);
      },
      // Its recordings deleted, then the song itself.
      async (tx) => void (await tx.update(recordings).set({ deletedAt: AT }).where(takes)),
      async (tx) => void (await tx.update(compositions).set({ deletedAt: AT }).where(song)),
    ];
    for (const edit of edits) {
      await database.transaction(async (tx) => {
        await edit(tx);
        const stale = await catalogSearchOf(tx);
        expect(stale.indexed).not.toEqual(stale.derived);
        await searchIndex.reindexSong(tx, paper);
        const fresh = await catalogSearchOf(tx);
        expect(fresh.indexed).toEqual(fresh.derived);
      });
      const committed = await catalogSearchOf(database);
      expect(committed.indexed).toEqual(committed.derived);
    }
    expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    const left = sql`SELECT count(*) AS n FROM catalog_search WHERE entity_id = ${paper}`;
    expect(await database.all(left)).toEqual([{ n: 0 }]);
  });
});

const refused = (error: object) => ({ ok: false, error });
const invalid = (field: string, reason: string) => refused({ code: 'VALIDATION', field, reason });

/** The audit rows for one composition, oldest first, with their JSON parsed. */
async function auditOf(entityId: string) {
  const database = await open(owner);
  const { auditLog } = tables;
  const rows = await database.select().from(auditLog).where(eq(auditLog.entityId, entityId));
  return rows.map(({ action, beforeJson, afterJson }) => ({
    ...{ action, before: beforeJson && JSON.parse(beforeJson) },
    after: afterJson && JSON.parse(afterJson),
  }));
}

/** catalog_search equals validate.mjs's derivation and every foreign key holds. */
async function consistent() {
  const database = await open(owner);
  const search = await catalogSearchOf(database);
  expect(search.indexed).toEqual(search.derived);
  expect(await database.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
}

describe('melos-rpr.13: createComposition and updateComposition (CAT-001, CAT-004)', () => {
  it('creates a song with alternate titles, audits it, indexes it and returns its MusicWorkspaceDTO', async () => {
    const input = {
      ...{ title: '  Glass  Harbor ', description: 'Slow build', lyrics: 'Waves' },
      ...{ iswc: 'T-034.524.680-1', copyrightRegistrationNumber: 'PAu 1-234-567' },
      ...{ copyrightDate: '2026-09-01', altTitles: [' Harbor ', 'Glass'] },
    };
    const created = await service.createComposition(owner, input);
    if (!created.ok) throw new Error(`Refused with ${created.error.code}`);
    const { composition, recordings, focus } = created.value;
    expect(focus.entityType).toBe('composition');
    expect(composition).toMatchObject({
      ...{ title: 'Glass  Harbor', iswc: 'T0345246801', hasLyrics: true },
      ...{ copyrightRegistrationNumber: 'PAu 1-234-567', copyrightDate: '2026-09-01' },
    });
    expect([...(composition?.altTitles ?? [])].sort()).toEqual(['Glass', 'Harbor']);
    expect(recordings).toEqual([]);
    const [audit, ...more] = await auditOf(focus.entityId);
    expect(more).toEqual([]);
    expect(audit).toMatchObject({ action: 'composition.create', before: null });
    expect(audit.after.altTitles.map((t: { title: string }) => t.title)).toEqual([
      'Glass',
      'Harbor',
    ]);
    await consistent();
  });

  it('refuses before writing: a blank title, a bad date, blank or repeated alternate titles, a bad ISWC or one a live song holds', async () => {
    const database = await open(owner);
    const count = sql`SELECT count(*) AS n FROM compositions`;
    const [before] = await database.all(count);
    const cases: [object, object][] = [
      [{ title: '  ' }, invalid('title', 'required')],
      [{ title: 'A', copyrightDate: '2026-02-30' }, invalid('copyrightDate', 'not_a_date')],
      [{ title: 'A', altTitles: [' '] }, invalid('altTitles', 'required')],
      [{ title: 'A', altTitles: ['B', ' B'] }, invalid('altTitles', 'duplicate_title')],
      [
        { title: 'A', iswc: 'T12' },
        refused({ code: 'INVALID_ISWC', field: 'iswc', reason: 'shape' }),
      ],
      [
        { title: 'A', iswc: 'T0345246802' },
        refused({ code: 'INVALID_ISWC', field: 'iswc', reason: 'check_digit' }),
      ],
      // Glass Harbor's ISWC, from the first test.
      [{ title: 'A', iswc: 'T034.524.680-1' }, refused({ code: 'CONFLICT', field: 'iswc' })],
    ];
    for (const [input, refusal] of cases) {
      const result = await service.createComposition(owner, input as { title: string });
      expect(result, JSON.stringify(input)).toEqual(refusal);
    }
    expect(await database.all(count)).toEqual([before]);
    const viewer = withRole(owner, 'viewer');
    expect(await service.createComposition(viewer, { title: 'A' })).toEqual(
      refused({ code: 'FORBIDDEN' }),
    );
  });

  it('patches only the fields given, replaces alternate titles, and audits the row before and after', async () => {
    const created = await service.createComposition(owner, {
      ...{ title: 'Lantern', iswc: 'T0000000010', altTitles: ['Keep', 'Drop'] },
    });
    if (!created.ok) throw new Error(`Refused with ${created.error.code}`);
    const id = created.value.focus.entityId;
    const database = await open(owner);
    const { compositionAltTitles } = tables;
    const kept = eq(compositionAltTitles.title, 'Keep');
    const [{ id: keptId }] = await database.select().from(compositionAltTitles).where(kept);

    const patched = await service.updateComposition(owner, id, {
      ...{ title: 'Lanterns', description: null, iswc: null, altTitles: ['Keep', 'New'] },
    });
    if (!patched.ok) throw new Error(`Refused with ${patched.error.code}`);
    expect(patched.value.composition).toMatchObject({ title: 'Lanterns', iswc: null });
    const titles = await database
      .select()
      .from(compositionAltTitles)
      .where(eq(compositionAltTitles.compositionId, id));
    expect(titles.map((t) => t.title).sort()).toEqual(['Keep', 'New']);
    expect(titles.find((t) => t.title === 'Keep')?.id).toBe(keptId);
    const audits = await auditOf(id);
    expect(audits.map((a) => a.action)).toEqual(['composition.create', 'composition.update']);
    expect(audits[1].before).toMatchObject({ title: 'Lantern', iswc: 'T0000000010' });
    expect(audits[1].after).toMatchObject({ title: 'Lanterns', iswc: null });
    await consistent();

    // The same values again change nothing and add no audit row.
    const same = await service.updateComposition(owner, id, {
      title: 'Lanterns',
      altTitles: ['New', 'Keep'],
    });
    expect(same.ok).toBe(true);
    expect(await auditOf(id)).toHaveLength(2);
  });

  it('keeps a stored ISWC on its shape, refuses a taken one, and refuses a missing song', async () => {
    // Midnight Drive's seeded ISWC has a wrong check digit, which only a new value is tested for (D-2).
    const midnight = NORTHSTAR.keys.cmp_MIDNIGHT;
    const kept = await service.updateComposition(owner, midnight, { iswc: 'T-900.000.001-0' });
    expect(kept.ok).toBe(true);
    expect(await auditOf(midnight)).toEqual([]);
    const ocean = NORTHSTAR.keys.cmp_OCEAN;
    expect(await service.updateComposition(owner, ocean, { iswc: 'T0345246801' })).toEqual(
      refused({ code: 'CONFLICT', field: 'iswc' }),
    );
    expect(await service.updateComposition(owner, `cmp_${ulid()}`, { title: 'X' })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
    expect(
      await service.updateComposition(withRole(owner, 'viewer'), ocean, { title: 'X' }),
    ).toEqual(refused({ code: 'FORBIDDEN' }));
  });
});

describe('melos-rpr.13: roles, tenancy and duplicates (CAT-001, §6.15)', () => {
  it('lets a member create, refuses a viewer without opening the database, and audits the actor and request', async () => {
    const member = withRole(owner, 'member');
    const created = await service.createComposition(member, { title: 'Member Song' });
    if (!created.ok) throw new Error(`Refused with ${created.error.code}`);
    const database = await open(owner);
    const { auditLog } = tables;
    const where = eq(auditLog.entityId, created.value.focus.entityId);
    const [row] = await database.select().from(auditLog).where(where);
    expect(row).toMatchObject({ actorUserId: owner.userId, requestId: owner.requestId });
    services.getWorkspaceDatabase.mockClear();
    const viewer = withRole(owner, 'viewer');
    await service.createComposition(viewer, { title: 'A' });
    await service.updateComposition(viewer, created.value.focus.entityId, { title: 'A' });
    expect(services.getWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it("answers NOT_FOUND for another workspace's composition", async () => {
    const other = await services.provision('owner');
    const paper = NORTHSTAR.keys.cmp_PAPER;
    expect(await service.updateComposition(other, paper, { title: 'Stolen' })).toEqual(
      refused({ code: 'NOT_FOUND' }),
    );
  });

  it('finds live compositions with the same normalized title or ISWC', async () => {
    const found = await service.findCompositionDuplicates(owner, {
      ...{ title: '  NEON   static ', iswc: 'T-034.524.680-1' },
    });
    if (!found.ok) throw new Error(`Refused with ${found.error.code}`);
    const matched = Object.fromEntries(found.value.map((d) => [d.title, d.matchedOn]));
    expect(matched).toEqual({ 'Neon Static': ['title'], 'Glass  Harbor': ['iswc'] });
  });
});
