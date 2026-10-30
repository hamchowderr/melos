import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ONE_STOP_CODES, SYNC_ONLY_CODES, WARNING_CODES } from '../../src/lib/dto/rights';
import type { TenantContext } from '../../src/server/services/tenant-context';
import { northstarWarnings } from './catalog-support';
import * as rig from './rights-support';

const { accepted, getWorkspaceDatabase, ID, K, keys, refused, table, withRole } = rig;
const env = rig.rightsWorkspaces('data/test-readiness-report');
let rights: typeof import('../../src/server/services/rights/read');
beforeAll(async () => {
  rights = await import('../../src/server/services/rights/read');
});
type Query = Parameters<typeof rights.getReadinessIssues>[1];
const issues = (tenant: TenantContext, query?: Query) => rights.getReadinessIssues(tenant, query);

describe('melos-rpr.7: RightsService reports readiness issues (RGT-005, DEMO-003)', () => {
  it('matches the EXPECTED.md §2 readiness table, licensing contacts included', async () => {
    const report = accepted(await issues(env.northstar, { onlyNotReady: false }));
    const list = (items: string[]) => items.join(', ') || 'none';
    const rows: string[][] = [];
    for (const { recordingId, title, oneStopReady, syncReady, ...found } of report.recordings) {
      const focus = { entityType: 'recording', entityId: recordingId } as const;
      const { licensingContacts } = accepted(await rights.getRightsSummary(env.northstar, focus));
      const codes = found.issues.map(({ code }) => code);
      const lists = [ONE_STOP_CODES, SYNC_ONLY_CODES, WARNING_CODES].map(
        (from: readonly string[]) => list(codes.filter((code) => from.includes(code))),
      );
      const contacts = licensingContacts.map(
        (c) => `${K(c.partyId)}${c.implicit ? ' (implicit)' : ''}`,
      );
      const flags = [`${oneStopReady}`, `${syncReady}`];
      rows.push([title, `${K(recordingId)}`, ...lists, ...flags, list(contacts)]);
    }
    expect(rows.sort()).toEqual(table('readiness').sort());
  });

  it('lists rec_NEON and rec_OCEAN as not ready by default and filters by composition, recording and limit', async () => {
    const notReady = accepted(await issues(env.northstar));
    const listed = notReady.recordings.map(({ recordingId }) => K(recordingId));
    expect(listed).toEqual(['rec_NEON', 'rec_OCEAN']);
    expect(Date.parse(notReady.generatedAt)).not.toBeNaN();
    const ocean = accepted(
      await issues(env.northstar, { compositionId: keys.cmp_OCEAN, limit: 1 }),
    );
    const oceanIds = { recordingId: keys.rec_OCEAN, compositionId: keys.cmp_OCEAN };
    expect(ocean.recordings).toMatchObject([{ ...oceanIds, title: 'Ocean Blue' }]);
    const midnight = { recordingId: keys.rec_MIDNIGHT };
    expect(accepted(await issues(env.northstar, midnight)).recordings).toEqual([]);
    const ready = accepted(await issues(env.northstar, { ...midnight, onlyNotReady: false }));
    const warnings = northstarWarnings(keys.rec_MIDNIGHT, keys.cmp_MIDNIGHT);
    const flags = { oneStopReady: true, syncReady: true, issues: warnings };
    expect(ready.recordings).toEqual([
      { ...midnight, compositionId: keys.cmp_MIDNIGHT, title: 'Midnight Drive', ...flags },
    ]);
    const limited = accepted(await issues(env.northstar, { onlyNotReady: false, limit: 2 }));
    expect(limited.recordings).toHaveLength(2);
    // limit applies after onlyNotReady: the first recording by title, Home Again, is ready.
    const first = accepted(await issues(env.northstar, { onlyNotReady: true, limit: 1 }));
    expect(first.recordings.map(({ recordingId }) => K(recordingId))).toEqual(['rec_NEON']);
    for (const invalid of [-1, 0]) {
      const all = accepted(await issues(env.northstar, { onlyNotReady: false, limit: invalid }));
      expect(all.recordings, `limit ${invalid} takes the default`).toHaveLength(5);
    }
    // A recording id leaves out the other recordings of its song.
    const r1 = accepted(await issues(env.other, { recordingId: ID.R1, onlyNotReady: false }));
    expect(r1.recordings.map(({ recordingId }) => recordingId)).toEqual([ID.R1]);
    // Every live recording of the second workspace by title, without GONE (deleted) and RX (its
    // composition is deleted).
    const other = accepted(await issues(env.other, { onlyNotReady: false }));
    const live = other.recordings.map(({ recordingId, compositionId }) => [
      recordingId,
      compositionId,
    ]);
    const songs = [
      [ID.R1, ID.C1],
      [ID.R2, ID.C1],
      [ID.R3, ID.C2],
      [ID.R4, ID.C2],
    ];
    expect(live).toEqual([[ID.LONE, null], ...songs]);
  });

  it('answers NOT_FOUND for a soft-deleted or other-workspace id and FORBIDDEN to owner,viewer before any open', async () => {
    const lookups: [TenantContext, Query][] = [
      [env.other, { recordingId: ID.GONE }],
      [env.northstar, { recordingId: ID.R1 }],
      [env.northstar, { compositionId: ID.C1 }],
      [env.other, { compositionId: keys.cmp_OCEAN }],
      [env.other, { recordingId: keys.rec_MIDNIGHT }],
    ];
    for (const [tenant, query] of lookups) {
      expect(await issues(tenant, query), JSON.stringify(query)).toEqual(refused('NOT_FOUND'));
    }
    getWorkspaceDatabase.mockClear();
    expect(accepted(await issues(withRole(env.northstar, 'viewer'))).recordings).toHaveLength(2);
    // Probe: the read asks for the database through the recorded function.
    expect(getWorkspaceDatabase).toHaveBeenCalledTimes(1);
    getWorkspaceDatabase.mockClear();
    expect(await issues(withRole(env.northstar, 'owner,viewer'))).toEqual(refused('FORBIDDEN'));
    expect(getWorkspaceDatabase).not.toHaveBeenCalled();
  });

  it('reads each call in one libSQL batch, one round trip to the workspace database (§1.4)', async () => {
    const { $client } = await env.connections.getWorkspaceDatabase(env.northstar.workspaceId);
    const spies = (['batch', 'execute', 'transaction'] as const).map((m) => vi.spyOn($client, m));
    try {
      await issues(env.northstar);
      await issues(env.northstar, { compositionId: keys.cmp_NEON });
      await issues(env.northstar, { recordingId: keys.rec_OCEAN });
      expect(spies.map((spy) => spy.mock.calls.length)).toEqual([3, 0, 0]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
