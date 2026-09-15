import { ulid } from 'ulid';
import { beforeAll, describe, expect, it } from 'vitest';
import { licensingContacts } from '../../src/server/db/schema/workspace.generated';
import type { TenantContext } from '../../src/server/services/tenant-context';
import * as rig from './rights-support';

const { AT, accepted, ID, K, keys, refused, table } = rig;
const env = rig.rightsWorkspaces('data/test-rights-summary-cases');
let rights: typeof import('../../src/server/services/rights/read');
beforeAll(async () => {
  rights = await import('../../src/server/services/rights/read');
});
type Focus = [TenantContext, 'composition' | 'recording', string];
const summary = (...[tenant, entityType, entityId]: Focus) =>
  rights.getRightsSummary(tenant, { entityType, entityId });

describe('melos-rpr.7: RightsService summarizes every song shape (RGT-001 to RGT-005)', () => {
  it('matches the EXPECTED.md §1 totals and holders tables for the five Northstar songs', async () => {
    const [totals, holders]: string[][][] = [[], []];
    const flags = (h: { isSelf: boolean; representationAttested: boolean }) => [
      '—',
      h.isSelf ? 'yes' : 'no',
      h.representationAttested ? 'yes' : 'no',
    ];
    for (const [song, composition] of table('totals')) {
      const found = accepted(await summary(env.northstar, 'composition', keys[composition]));
      const [{ territory, totalBp, holders: publishers }] = found.publishing;
      const [{ recordingId, holders: owners, ...master }] = found.masters;
      const sizes = [found.writers.length, territory, totalBp, publishers.length, master.totalBp];
      const row = [song, composition, K(recordingId), found.writerTotalBp, ...sizes, owners.length];
      totals.push(row.map(String));
      type Holder = { partyId: string; displayName: string; shareBp: number | null };
      const add = (side: string, h: Holder, cells: unknown[]) =>
        holders.push([song, side, K(h.partyId), h.displayName, h.shareBp, ...cells].map(String));
      // RightsSummaryDTO writers carry no isSelf (§3.4), so that cell is compared blank.
      for (const writer of found.writers) add('writer', writer, [writer.roles.join(), '', '—']);
      for (const h of publishers) add(`publishing ${territory}`, h, flags(h));
      for (const h of owners) add('master', h, flags(h));
    }
    expect(totals).toEqual(table('totals').map((cells) => cells.slice(0, 10)));
    const blank = (cells: string[]) =>
      cells.map((c, i) => (i === 6 && cells[1] === 'writer' ? '' : c));
    expect(holders).toEqual(table('holders').map(blank));
  });

  it('merges contacts per song: every recording qualifies, one does not, an explicit contact wins (P-28)', async () => {
    const contactsOf = async (id: string) =>
      accepted(await summary(env.other, 'composition', id)).licensingContacts;
    const c2 = accepted(await summary(env.other, 'recording', ID.R3));
    // The deleted recording's O master would otherwise leave C2 without the implicit contact.
    expect(c2.masters.map(({ recordingId }) => recordingId)).toEqual([ID.R3, ID.R4]);
    expect(c2.licensingContacts).toEqual([{ partyId: ID.S, displayName: 'S', implicit: true }]);
    // R1 alone has the implicit contact, but R2's master is not controlled, so song C1 has none.
    const c1 = accepted(await summary(env.other, 'composition', ID.C1));
    const uncovered = c1.issues.filter(({ code }) => code === 'NO_LICENSING_CONTACT');
    const byRecording = uncovered.map(({ recordingId }) => recordingId);
    expect([c1.licensingContacts, byRecording]).toEqual([[], [ID.R2]]);
    const database = await env.connections.getWorkspaceDatabase(env.other.workspaceId);
    const contact = { id: `lic_${ulid()}`, recordingId: ID.R2, partyId: ID.O };
    await database.insert(licensingContacts).values({ ...contact, createdAt: AT, updatedAt: AT });
    try {
      const explicit = [{ partyId: ID.O, displayName: 'O', implicit: false }];
      expect(await contactsOf(ID.C1)).toEqual(explicit);
    } finally {
      await database.delete(licensingContacts);
    }
  });

  it('gives a recording without a composition only its master side', async () => {
    const lone = accepted(await summary(env.other, 'recording', ID.LONE));
    const empty = { compositionId: null, writers: [], writerTotalBp: 0, publishing: [] };
    const masters = [{ recordingId: ID.LONE, totalBp: 10000 }];
    expect(lone).toMatchObject({ ...empty, masters, licensingContacts: [] });
    const codes = ['NO_COMPOSITION', 'NO_LICENSING_CONTACT', 'MISSING_ISRC', 'NO_LISTEN_LINK'];
    expect(lone.issues.map(({ code }) => code)).toEqual(codes);
  });

  it('answers NOT_FOUND for a soft-deleted id or one from the other workspace (TEN-001)', async () => {
    const lookups: Focus[] = [
      [env.other, 'recording', ID.GONE],
      [env.northstar, 'composition', ID.C1],
      [env.northstar, 'recording', ID.LONE],
      [env.other, 'composition', keys.cmp_OCEAN],
      [env.other, 'recording', keys.rec_MIDNIGHT],
    ];
    for (const lookup of lookups) {
      expect(await summary(...lookup), lookup[2]).toEqual(refused('NOT_FOUND'));
    }
  });
});
