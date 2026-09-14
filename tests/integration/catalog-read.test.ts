import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '../../src/lib/auth/permissions';
import { organization } from '../../src/server/db/schema/auth';
import { compositions, recordings } from '../../src/server/db/schema/workspace.generated';
import type { ServiceResult } from '../../src/server/services/service-result';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { openWithoutForeignKeys } from './support';

type Connections = typeof import('../../src/server/services/workspace-connections');

const DATA_DIR = 'data/test-catalog-read';
const AT = '2026-09-14T17:00:00.000Z';
const fixture = JSON.parse(readFileSync('docs/fixtures/northstar-demo.json', 'utf8'));
const { keys } = fixture as { keys: Record<string, string> };
/** The second workspace: a song with an original, a remix and a deleted take, and a lone single. */
const OTHER = { song: `cmp_${ulid()}`, original: `rec_${ulid()}`, remix: `rec_${ulid()}` };
const LONE = { single: `rec_${ulid()}`, deleted: `rec_${ulid()}` };
const getWorkspaceDatabase = vi.fn<Connections['getWorkspaceDatabase']>();
let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;
let connections: Connections;
let catalog: typeof import('../../src/server/services/catalog/read');
let northstar: TenantContext;
let other: TenantContext;

/** A role TenantContextResolver refuses can still reach a service called another way. */
const withRole = (tenant: TenantContext, role: string) => ({
  ...tenant,
  workspaceRole: role as WorkspaceRole,
});
function accepted<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`Refused with ${result.error.code}`);
  return result.value;
}

beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.env.MELOS_WORKSPACE_DATA_DIR = `${DATA_DIR}/workspaces`;
  // One in-memory control connection with foreign keys off, as in northstar-seed.test.ts.
  const migrationsFolder = './src/server/db/migrations/control';
  control = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder }));
  const controlClient = { controlDb: control, controlDatabaseClient: control.$client };
  vi.doMock('../../src/server/db/client', () => controlClient);
  // Records every request for a workspace database.
  vi.doMock('../../src/server/services/workspace-connections', async (importOriginal) => {
    const original = await importOriginal<Connections>();
    getWorkspaceDatabase.mockImplementation(original.getWorkspaceDatabase);
    return { ...original, getWorkspaceDatabase };
  });
  connections = await import('../../src/server/services/workspace-connections');
  catalog = await import('../../src/server/services/catalog/read');
  const { seedNorthstar } = await import('../../src/server/db/seed/northstar');
  const { provisionWorkspace } = await import('../../src/server/services/workspace-provisioner');

  const seeded = await seedNorthstar({ password: 'catalog-read-password', seedDate: '2026-09-14' });
  expect(seeded).toMatchObject({ status: 'seeded', dateShift: 0 });
  const { organizationId, workspaceId } = seeded as Extract<typeof seeded, { status: 'seeded' }>;
  const tenant = { userId: keys.usr_JORDAN, workspaceRole: 'owner', requestId: 'catalog' } as const;
  northstar = { ...tenant, organizationId, workspaceId };

  const created = {
    id: `organization_${ulid()}`,
    name: 'Other',
    slug: 'other',
    createdAt: new Date(),
  };
  await control.insert(organization).values(created);
  const registry = await provisionWorkspace(created.id);
  other = { ...tenant, organizationId: created.id, workspaceId: registry.id };
  const database = await connections.getWorkspaceDatabase(registry.id);
  const row = (
    id: string,
    title: string,
    values: Partial<typeof recordings.$inferInsert> = {},
  ) => ({
    ...{ id, title, createdAt: AT, updatedAt: AT, ...values },
  });
  await database.batch([
    database.insert(compositions).values(row(OTHER.song, 'Midnight Drive')),
    database
      .insert(recordings)
      .values([
        row(OTHER.remix, 'Midnight Drive', { compositionId: OTHER.song, versionTitle: 'Remix' }),
        row(OTHER.original, ' midnight  DRIVE', { compositionId: OTHER.song }),
        row(LONE.deleted, 'Midnight Drive', { compositionId: OTHER.song, deletedAt: AT }),
        row(LONE.single, 'After Hours'),
      ]),
  ]);
});

afterAll(async () => {
  for (const tenant of [northstar, other]) {
    if (tenant) await connections.closeWorkspaceDatabase(tenant.workspaceId);
  }
  control?.$client.close();
});

describe('melos-rpr.1: CatalogService lists songs (CAT-009)', () => {
  it('lists the 5 Northstar songs by normalized title, each a composition with its recording', async () => {
    const songs = accepted(await catalog.listSongs(northstar));
    const song = (name: string) => ({
      compositionId: keys[`cmp_${name}`],
      primaryRecordingId: keys[`rec_${name}`],
      recordings: [{ recordingId: keys[`rec_${name}`] }],
    });
    expect(songs).toMatchObject(['HOME', 'MIDNIGHT', 'NEON', 'OCEAN', 'PAPER'].map(song));
    const titles = [
      'Home Again',
      'Midnight Drive',
      'Neon Static',
      'Ocean Blue',
      'Paper Planes at 2AM',
    ];
    expect(songs.map(({ title }) => title)).toEqual(titles);
    const midnight = { iswc: 'T9000000010', primaryArtistNames: ['Jordan Taylor'] };
    expect(songs[1]).toMatchObject({ ...midnight, recordings: [{ isrc: 'USDMO2600001' }] });
    expect(songs[4].altTitles).toEqual(['Paper Planes']);
  });

  it('leaves a soft-deleted composition out of the list', async () => {
    const database = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const setDeletedAt = (deletedAt: string | null) =>
      database.update(compositions).set({ deletedAt }).where(eq(compositions.id, keys.cmp_HOME));
    await setDeletedAt(AT);
    try {
      const titles = accepted(await catalog.listSongs(northstar)).map(({ title }) => title);
      expect(titles).toEqual([
        'Midnight Drive',
        'Neon Static',
        'Ocean Blue',
        'Paper Planes at 2AM',
      ]);
    } finally {
      await setDeletedAt(null);
    }
    expect(accepted(await catalog.listSongs(northstar))).toHaveLength(5);
  });

  it('lets a viewer read and refuses owner,viewer with FORBIDDEN before opening the database (§6.2, P-30)', async () => {
    getWorkspaceDatabase.mockClear();
    const viewer = withRole(northstar, 'viewer');
    expect(accepted(await catalog.listSongs(viewer))).toHaveLength(5);
    // Probe: a read asks for the database through the recorded function.
    expect(getWorkspaceDatabase).toHaveBeenCalledTimes(1);
    getWorkspaceDatabase.mockClear();
    const refused = withRole(northstar, 'owner,viewer');
    const forbidden = { ok: false, error: { code: 'FORBIDDEN' } };
    expect(await catalog.listSongs(refused)).toEqual(forbidden);
    expect(getWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it('lists only the second workspace songs: several recordings grouped, a lone recording alone (§3.5)', async () => {
    const song = { compositionId: OTHER.song, primaryRecordingId: OTHER.original };
    const single = { compositionId: null, primaryRecordingId: LONE.single, title: 'After Hours' };
    expect(accepted(await catalog.listSongs(other))).toMatchObject([
      { ...single, altTitles: [], iswc: null, recordings: [{ recordingId: LONE.single }] },
      {
        ...{ ...song, title: 'Midnight Drive', altTitles: [], iswc: null },
        recordings: [{ recordingId: OTHER.original }, { recordingId: OTHER.remix }],
      },
    ]);
  });

  it('reads the list in one libSQL batch, one round trip to the workspace database (§1.4)', async () => {
    const { $client } = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const methods = ['batch', 'execute', 'transaction'] as const;
    const spies = methods.map((method) => vi.spyOn($client, method));
    try {
      await catalog.listSongs(northstar);
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([1, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
