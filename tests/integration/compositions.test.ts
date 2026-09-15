import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tables from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import type { WorkspaceTransaction } from '../../src/server/services/workspace-write';
import { catalogSearchOf, NORTHSTAR, seedNorthstarTenant } from './catalog-support';
import { prepareWorkspaceServices } from './workspace-service';

type Services = Awaited<ReturnType<typeof prepareWorkspaceServices>>;
type SearchIndex = typeof import('../../src/server/services/catalog/search-index');

const AT = '2026-09-15T12:00:00.000Z';
let services: Services;
let searchIndex: SearchIndex;
let owner: TenantContext;

const open = (tenant: TenantContext) =>
  services.connections.getWorkspaceDatabase(tenant.workspaceId);

beforeAll(async () => {
  services = await prepareWorkspaceServices('compositions');
  searchIndex = await import('../../src/server/services/catalog/search-index');
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
