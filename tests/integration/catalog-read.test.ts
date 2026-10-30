import { readFileSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRole } from '../../src/lib/auth/permissions';
import type { CatalogFocus } from '../../src/lib/dto/catalog';
import { organization } from '../../src/server/db/schema/auth';
import {
  artistAliases,
  compositions,
  metadataTerms,
  parties,
  recordingArtists,
  recordingContributors,
  recordings,
  recordingTerms,
  releases,
  releaseTracks,
} from '../../src/server/db/schema/workspace.generated';
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
/** Songs with no primary recording (§3.5): two matching takes, no match, no live recording. */
const NO_PRIMARY = { twins: `cmp_${ulid()}`, split: `cmp_${ulid()}`, empty: `cmp_${ulid()}` };
const NOT_FOUND = { ok: false, error: { code: 'NOT_FOUND' } };
const JORDAN = { partyId: keys.pty_JORDAN, artistAliasId: null, displayName: 'Jordan Taylor' };
const getWorkspaceDatabase = vi.fn<Connections['getWorkspaceDatabase']>();
let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;
let connections: Connections;
let catalog: typeof import('../../src/server/services/catalog/read');
let northstar: TenantContext;
let other: TenantContext;

const read = (tenant: TenantContext, entityType: CatalogFocus['entityType'], entityId: string) =>
  catalog.getSongCatalog(tenant, { entityType, entityId });
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
      .insert(compositions)
      .values([
        row(NO_PRIMARY.twins, 'Twins'),
        row(NO_PRIMARY.split, 'Split'),
        row(NO_PRIMARY.empty, 'Unrecorded'),
      ]),
    database
      .insert(recordings)
      .values([
        row(OTHER.remix, 'Midnight Drive', { compositionId: OTHER.song, versionTitle: 'Remix' }),
        row(OTHER.original, ' midnight  DRIVE', { compositionId: OTHER.song }),
        row(LONE.deleted, 'Midnight Drive', { compositionId: OTHER.song, deletedAt: AT }),
        row(LONE.single, 'After Hours'),
        row(`rec_${ulid()}`, 'Twins', { compositionId: NO_PRIMARY.twins }),
        row(`rec_${ulid()}`, ' twins', { compositionId: NO_PRIMARY.twins }),
        row(`rec_${ulid()}`, 'Split', { compositionId: NO_PRIMARY.split, versionTitle: 'Live' }),
        row(`rec_${ulid()}`, 'Split (Demo)', { compositionId: NO_PRIMARY.split }),
      ]),
  ]);
});

afterAll(async () => {
  for (const tenant of [northstar, other]) {
    if (tenant) await connections.closeWorkspaceDatabase(tenant.workspaceId);
  }
  control?.$client.close();
});

describe('melos-rpr.1: CatalogService reads songs and song details (CAT-002, CAT-004, CAT-009)', () => {
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

  it('reads Midnight Drive by composition or recording id: ISWC, ISRC and primary link from 42000 ms (DEMO-001)', async () => {
    const song = accepted(await read(northstar, 'composition', keys.cmp_MIDNIGHT));
    const link = { id: keys.lnk_MIDNIGHT, linkType: 'private_player', label: 'Listen' };
    const primaryLink = { ...link, url: 'https://media.example/midnight-drive', isPrimary: true };
    expect(song).toEqual({
      focus: { entityType: 'composition', entityId: keys.cmp_MIDNIGHT },
      composition: {
        ...{ id: keys.cmp_MIDNIGHT, title: 'Midnight Drive', altTitles: [], iswc: 'T9000000010' },
        ...{ copyrightRegistrationNumber: null, copyrightDate: null, description: null },
        ...{ hasLyrics: false, registrations: [] },
      },
      primaryRecordingId: keys.rec_MIDNIGHT,
      recordings: [
        {
          ...{ id: keys.rec_MIDNIGHT, title: 'Midnight Drive', versionTitle: null },
          ...{ isrc: 'USDMO2600001', durationMs: null, bpm: null, musicalKey: null },
          ...{ previewStartMs: 42000, primaryLink, links: [primaryLink] },
          ...{ artists: [{ ...JORDAN, role: 'primary', billingOrder: 0 }] },
          ...{ contributors: [], terms: [], registrations: [] },
        },
      ],
      releases: [],
    });
    const focus = { entityType: 'recording', entityId: keys.rec_MIDNIGHT };
    const byRecording = accepted(await read(northstar, 'recording', keys.rec_MIDNIGHT));
    expect(byRecording).toEqual({ ...song, focus });
  });

  it('gives Paper Planes at 2AM its alternate title and credits Alex Ramirez as featured on Ocean Blue', async () => {
    const paper = accepted(await read(northstar, 'recording', keys.rec_PAPER));
    expect(paper.composition?.altTitles).toEqual(['Paper Planes']);
    const ocean = accepted(await read(northstar, 'composition', keys.cmp_OCEAN));
    expect(ocean.composition?.hasLyrics).toBe(true);
    const alex = { partyId: keys.pty_ALEX, artistAliasId: null, displayName: 'Alex Ramirez' };
    expect(ocean.recordings[0].artists).toEqual([
      { ...JORDAN, role: 'primary', billingOrder: 0 },
      { ...alex, role: 'featured', billingOrder: 1 },
    ]);
  });

  it('leaves a soft-deleted composition out of the list and answers NOT_FOUND for its song', async () => {
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
      expect(await read(northstar, 'composition', keys.cmp_HOME)).toEqual(NOT_FOUND);
      // Its live recording resolves to the deleted song.
      expect(await read(northstar, 'recording', keys.rec_HOME)).toEqual(NOT_FOUND);
    } finally {
      await setDeletedAt(null);
    }
    expect(accepted(await catalog.listSongs(northstar))).toHaveLength(5);
  });

  it('lets a viewer read and refuses owner,viewer with FORBIDDEN before opening the database (§6.2, P-30)', async () => {
    getWorkspaceDatabase.mockClear();
    const viewer = withRole(northstar, 'viewer');
    expect(accepted(await catalog.listSongs(viewer))).toHaveLength(5);
    const song = accepted(await read(viewer, 'composition', keys.cmp_MIDNIGHT));
    expect(song.composition?.iswc).toBe('T9000000010');
    // Probe: each read asks for the database through the recorded function.
    expect(getWorkspaceDatabase).toHaveBeenCalledTimes(2);
    getWorkspaceDatabase.mockClear();
    const refused = withRole(northstar, 'owner,viewer');
    const forbidden = { ok: false, error: { code: 'FORBIDDEN' } };
    expect(await catalog.listSongs(refused)).toEqual(forbidden);
    expect(await read(refused, 'recording', keys.rec_MIDNIGHT)).toEqual(forbidden);
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
      { compositionId: NO_PRIMARY.split, primaryRecordingId: null, recordings: [{}, {}] },
      { compositionId: NO_PRIMARY.twins, primaryRecordingId: null, recordings: [{}, {}] },
      { compositionId: NO_PRIMARY.empty, primaryRecordingId: null, recordings: [] },
    ]);
    const remix = { composition: { id: OTHER.song }, primaryRecordingId: OTHER.original };
    expect(accepted(await read(other, 'recording', OTHER.remix))).toMatchObject(remix);
    const takes = [{ id: LONE.single }];
    const alone = { composition: null, primaryRecordingId: LONE.single, recordings: takes };
    expect(accepted(await read(other, 'recording', LONE.single))).toMatchObject(alone);
    expect(await read(other, 'recording', LONE.deleted)).toEqual(NOT_FOUND);
  });

  it('shows a release track, a term, a recording contributor and an alias credit from setup rows (CAT-004, CAT-007, CAT-008)', async () => {
    const database = await connections.getWorkspaceDatabase(other.workspaceId);
    const recordingId = OTHER.original;
    const stamps = { createdAt: AT, updatedAt: AT };
    const party = { id: `pty_${ulid()}`, partyKind: 'person', displayName: 'Sam Rivera' };
    const alias = { id: ulid(), partyId: party.id, aliasName: 'DJ Sam', createdAt: AT };
    const term = { id: `trm_${ulid()}`, termType: 'genre', label: 'Synthwave' };
    const release = {
      ...{ id: `rel_${ulid()}`, title: 'Night Tapes', releaseType: 'single' },
      ...{ upcEan: '012345678905', releaseDate: '2026-09-01' },
    };
    // A soft-deleted release holding the recording is left out; tracks sort by number, not id.
    const deleted = { ...release, id: `rel_${ulid()}`, deletedAt: AT };
    const [first, last] = [OTHER.original, OTHER.remix].sort();
    const credit = { partyId: party.id, artistAliasId: alias.id, role: 'primary', billingOrder: 0 };
    const contributor = { partyId: party.id, role: 'producer', creditText: 'Produced by Sam' };
    await database.batch([
      database.insert(parties).values({ ...party, ...stamps }),
      database.insert(artistAliases).values(alias),
      database.insert(recordingArtists).values({ id: ulid(), recordingId, ...credit }),
      database.insert(recordingContributors).values({ id: ulid(), recordingId, ...contributor }),
      database.insert(metadataTerms).values({ ...term, normalizedLabel: 'synthwave' }),
      database.insert(recordingTerms).values({ recordingId, termId: term.id }),
      database.insert(releases).values([release, deleted].map((row) => ({ ...row, ...stamps }))),
      database.insert(releaseTracks).values([
        { releaseId: release.id, recordingId: first, trackNumber: 2 },
        { releaseId: release.id, recordingId: last, trackNumber: 1 },
        { releaseId: deleted.id, recordingId, trackNumber: 1 },
      ]),
    ]);
    try {
      const song = accepted(await read(other, 'composition', OTHER.song));
      expect(song.recordings.find(({ id }) => id === recordingId)).toMatchObject({
        primaryLink: null,
        artists: [{ ...credit, displayName: 'DJ Sam' }],
        contributors: [{ ...contributor, displayName: 'Sam Rivera' }],
        terms: [term],
      });
      expect(song.releases).toEqual([
        { ...release, discNumber: 1, recordingId: last, trackNumber: 1 },
        { ...release, discNumber: 1, recordingId: first, trackNumber: 2 },
      ]);
      expect(accepted(await catalog.listSongs(other))[1].primaryArtistNames).toEqual(['DJ Sam']);
    } finally {
      // Children first, so later tests see the second workspace as beforeAll wrote it.
      const tracks = [releaseTracks, releases, recordingTerms, metadataTerms];
      const credits = [recordingContributors, recordingArtists, artistAliases, parties];
      for (const table of [...tracks, ...credits]) await database.delete(table);
    }
  });

  it('answers NOT_FOUND for an id from the other workspace, in both directions (TEN-001)', async () => {
    const lookups: [TenantContext, CatalogFocus['entityType'], string][] = [
      [northstar, 'composition', OTHER.song],
      [northstar, 'recording', LONE.single],
      [other, 'composition', keys.cmp_MIDNIGHT],
      [other, 'recording', keys.rec_MIDNIGHT],
    ];
    for (const lookup of lookups) expect(await read(...lookup), lookup[2]).toEqual(NOT_FOUND);
  });

  it('reads each call in one libSQL batch, one round trip to the workspace database (§1.4)', async () => {
    const { $client } = await connections.getWorkspaceDatabase(northstar.workspaceId);
    const methods = ['batch', 'execute', 'transaction'] as const;
    const spies = methods.map((method) => vi.spyOn($client, method));
    try {
      await catalog.listSongs(northstar);
      await read(northstar, 'recording', keys.rec_MIDNIGHT);
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([2, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
