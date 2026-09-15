import { ulid } from 'ulid';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CatalogFocus } from '../../src/lib/dto/catalog';
import * as ws from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import * as rig from './rights-support';

const { AT, accepted, getWorkspaceDatabase, ID, K, keys, refused, table, withRole } = rig;
const env = rig.rightsWorkspaces('data/test-music-workspace');
let catalog: typeof import('../../src/server/services/catalog/read');
let rights: typeof import('../../src/server/services/rights/read');
let service: typeof import('../../src/server/services/catalog/music-workspace');
beforeAll(async () => {
  catalog = await import('../../src/server/services/catalog/read');
  rights = await import('../../src/server/services/rights/read');
  service = await import('../../src/server/services/catalog/music-workspace');
});
type Lookup = [TenantContext, CatalogFocus['entityType'], string];
const load = (...[tenant, entityType, entityId]: Lookup) =>
  service.getMusicWorkspace(tenant, { entityType, entityId });

describe('melos-rpr.10: getMusicWorkspace assembles MusicWorkspaceDTO (§3.4, DEMO-001)', () => {
  it('joins Midnight Drive catalog, rights, readiness and pitch counts from EXPECTED.md', async () => {
    const focus = { entityType: 'composition', entityId: keys.cmp_MIDNIGHT } as const;
    const midnight = accepted(await load(env.northstar, focus.entityType, focus.entityId));
    expect(midnight).toEqual({
      ...accepted(await catalog.getSongCatalog(env.northstar, focus)),
      rights: accepted(await rights.getRightsSummary(env.northstar, focus)),
      readiness: [
        { recordingId: keys.rec_MIDNIGHT, oneStopReady: true, syncReady: true, issues: [] },
      ],
      pitchSummary: {
        ...{ itemCount: 3, countsByStatus: { archived: 1, awaiting_reply: 1, sent: 1 } },
        lastActivityAt: '2026-09-04T16:05:00.000Z',
      },
      importedReportTemplateId: null,
    });
    const take = { isrc: 'USDMO2600001', previewStartMs: 42000, primaryLink: { isPrimary: true } };
    expect(midnight).toMatchObject({ composition: { iswc: 'T9000000010' }, recordings: [take] });
    const [, , counts] =
      table('facts').find(([, fact]) => fact === 'pitch_counts cmp_MIDNIGHT') ?? [];
    const written = Object.entries(midnight.pitchSummary.countsByStatus).map((c) => c.join(' '));
    expect(written.join(', ')).toBe(counts);
    const byRecording = accepted(await load(env.northstar, 'recording', keys.rec_MIDNIGHT));
    expect(byRecording).toEqual({
      ...midnight,
      focus: { ...focus, entityType: 'recording', entityId: keys.rec_MIDNIGHT },
    });
  });

  it('counts a composition cell, a pitch-level event and no pitches, with readiness per recording', async () => {
    const neon = accepted(await load(env.northstar, 'recording', keys.rec_NEON));
    expect(neon.pitchSummary).toEqual({
      ...{ itemCount: 3, countsByStatus: { interested: 1, requested_more: 1, sent: 1 } },
      lastActivityAt: '2026-09-10T18:00:00.000Z',
    });
    const flags = { oneStopReady: false, syncReady: false };
    expect(neon.readiness).toMatchObject([{ recordingId: keys.rec_NEON, ...flags }]);
    const lone = accepted(await load(env.other, 'recording', ID.LONE));
    expect(lone).toMatchObject({ composition: null, rights: { compositionId: null } });
    const [{ issues, ...alone }] = lone.readiness;
    expect([alone, issues[0].code]).toEqual([{ recordingId: ID.LONE, ...flags }, 'NO_COMPOSITION']);
    const c1 = accepted(await load(env.other, 'composition', ID.C1));
    expect(c1.readiness.map(({ recordingId }) => recordingId)).toEqual([ID.R1, ID.R2]);
    expect(c1.pitchSummary).toEqual({ itemCount: 0, countsByStatus: {}, lastActivityAt: null });

    // A cell on R1 whose pitch has a later event naming no cell; another pitch's event is not counted.
    const database = await env.connections.getWorkspaceDatabase(env.other.workspaceId);
    const stamps = { createdAt: AT, updatedAt: AT };
    const contact = { id: `con_${ulid()}`, partyId: ID.S, ...stamps };
    const [pitch, elsewhere] = [`pit_${ulid()}`, `pit_${ulid()}`];
    const item = { id: `pti_${ulid()}`, pitchId: pitch, recordingId: ID.R1, currentStatus: 'sent' };
    const event = (pitchId: string, pitchItemId: string | null, occurredAt: string) => ({
      ...{ id: `pev_${ulid()}`, pitchId, pitchItemId, eventType: 'call', actorType: 'user' },
      occurredAt,
    });
    await database.batch([
      database.insert(ws.contacts).values(contact),
      database
        .insert(ws.pitches)
        .values([pitch, elsewhere].map((id) => ({ id, contactId: contact.id, ...stamps }))),
      database.insert(ws.pitchItems).values({ ...item, ...stamps }),
      database
        .insert(ws.pitchEvents)
        .values([
          event(pitch, item.id, '2026-09-01T00:00:00.000Z'),
          event(pitch, null, '2026-09-02T00:00:00.000Z'),
          event(elsewhere, null, '2026-09-03T00:00:00.000Z'),
        ]),
    ]);
    const late = '2026-09-02T00:00:00.000Z';
    const summary = { itemCount: 1, countsByStatus: { sent: 1 }, lastActivityAt: late };
    expect(accepted(await load(env.other, 'recording', ID.R2)).pitchSummary).toEqual(summary);
  });

  it('gives listSongs rows the one-stop and sync flags of EXPECTED.md §2', async () => {
    const songs = accepted(await catalog.listSongs(env.northstar));
    const rows = songs.flatMap(({ title, recordings }) =>
      recordings.map((r) => [title, K(r.recordingId), `${r.oneStopReady}`, `${r.syncReady}`]),
    );
    const expected = table('readiness').map((row) => [row[0], row[1], row[5], row[6]]);
    expect(rows.sort()).toEqual(expected.sort());
  });

  it('reads again when a recording lands between the batches, and fails if it lands again', async () => {
    const database = await env.connections.getWorkspaceDatabase(env.other.workspaceId);
    const batch = database.$client.batch.bind(database.$client);
    let landings = 1;
    // Before a rights batch (the one reading recording_master_totals), a recording joins C3.
    const spy = vi.spyOn(database.$client, 'batch').mockImplementation(async (statements, mode) => {
      if (landings > 0 && JSON.stringify(statements).includes('recording_master_totals')) {
        landings -= 1;
        const take = { id: `rec_${ulid()}`, title: 'Take', compositionId: ID.C3 };
        await database.insert(ws.recordings).values({ ...take, createdAt: AT, updatedAt: AT });
      }
      return batch(statements, mode);
    });
    try {
      const song = accepted(await load(env.other, 'composition', ID.C3));
      expect(spy).toHaveBeenCalledTimes(4);
      const ids = [song.recordings.map(({ id }) => id)];
      const read = [song.readiness, song.rights.masters].map((l) => l.map((r) => r.recordingId));
      expect([ids[0].length, ...read]).toEqual([1, ...ids, ...ids]);
      landings = 2;
      const changed = { name: 'WorkspaceConnectionError', code: 'SongChangedDuringRead' };
      await expect(load(env.other, 'composition', ID.C3)).rejects.toMatchObject(changed);
      expect(spy).toHaveBeenCalledTimes(8);
    } finally {
      spy.mockRestore();
    }
  });

  it('answers NOT_FOUND for a soft-deleted or other-workspace id and FORBIDDEN before any open', async () => {
    const lookups: Lookup[] = [
      [env.northstar, 'composition', ID.C1],
      [env.northstar, 'recording', ID.R1],
      [env.other, 'composition', keys.cmp_MIDNIGHT],
      [env.other, 'recording', keys.rec_MIDNIGHT],
      [env.other, 'recording', ID.GONE],
      [env.other, 'composition', ID.CX],
      [env.other, 'recording', ID.RX],
    ];
    for (const lookup of lookups)
      expect(await load(...lookup), lookup[2]).toEqual(refused('NOT_FOUND'));
    getWorkspaceDatabase.mockClear();
    const viewer = accepted(
      await load(withRole(env.northstar, 'viewer'), 'composition', keys.cmp_OCEAN),
    );
    expect(viewer.composition?.title).toBe('Ocean Blue');
    // Probe: the catalog and rights reads each ask for the database through the recorded function.
    expect(getWorkspaceDatabase).toHaveBeenCalledTimes(2);
    getWorkspaceDatabase.mockClear();
    const refusedRole = withRole(env.northstar, 'owner,viewer');
    expect(await load(refusedRole, 'recording', keys.rec_MIDNIGHT)).toEqual(refused('FORBIDDEN'));
    expect(getWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it('reads getMusicWorkspace in two libSQL batches and listSongs in one (§1.4)', async () => {
    const { $client } = await env.connections.getWorkspaceDatabase(env.northstar.workspaceId);
    const spies = (['batch', 'execute', 'transaction'] as const).map((m) => vi.spyOn($client, m));
    const calls = () => spies.map((spy) => spy.mock.calls.length);
    try {
      await load(env.northstar, 'recording', keys.rec_OCEAN);
      expect(calls()).toEqual([2, 0, 0]);
      await catalog.listSongs(env.northstar);
      expect(calls()).toEqual([3, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
