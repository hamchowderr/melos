import type { Client } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  artistAliases,
  compositionContributorRoles,
  compositionContributors,
  compositions,
  masterInterests,
  parties,
  partyIdentifiers,
  pitchItems,
  recordingArtists,
  recordings,
} from '../../src/server/db/schema/workspace.generated';
import { applyWorkspaceMigrations } from '../../src/server/db/workspace-migrations';
import { workspaceIntegrityGuard as guard } from '../../src/server/services/integrity-guard';
import { expectForeignKeysIntact, openWithoutForeignKeys } from './support';

const AT = '2026-09-13T00:00:00.000Z';
const STAMPS = { createdAt: AT, updatedAt: AT };
const T = `'${AT}', '${AT}'`;

// Jordan and Alex write Ocean Blue; Jordan records it as JT; Northstar owns its master. Sam is a
// contact with two pitches: pit_1 holds the Ocean Blue recording, pit_2 the composition and a demo
// recording of Night Drive.
const SEED = [
  `INSERT INTO parties (id, party_kind, display_name, created_at, updated_at) VALUES ('pty_jordan', 'person', 'Jordan', ${T}), ('pty_alex', 'person', 'Alex', ${T}), ('pty_northstar', 'organization', 'Northstar', ${T}), ('pty_sam', 'person', 'Sam', ${T})`,
  `INSERT INTO artist_aliases (id, party_id, alias_name, created_at) VALUES ('ali_jt', 'pty_jordan', 'JT', '${AT}')`,
  `INSERT INTO party_identifiers (id, party_id, artist_alias_id, identifier_type, identifier_value, created_at) VALUES ('pid_jt', 'pty_jordan', 'ali_jt', 'IPI', '00000000001', '${AT}')`,
  `INSERT INTO compositions (id, title, created_at, updated_at) VALUES ('cmp_ocean', 'Ocean Blue', ${T}), ('cmp_night', 'Night Drive', ${T}), ('cmp_spare', 'Spare', ${T})`,
  `INSERT INTO recordings (id, composition_id, title, created_at, updated_at) VALUES ('rec_ocean', 'cmp_ocean', 'Ocean Blue', ${T}), ('rec_night', 'cmp_night', 'Night Drive', ${T}), ('rec_demo', 'cmp_night', 'Night Drive (demo)', ${T})`,
  `INSERT INTO composition_contributors (id, composition_id, party_id, created_at, updated_at) VALUES ('ctr_jordan', 'cmp_ocean', 'pty_jordan', ${T}), ('ctr_alex', 'cmp_ocean', 'pty_alex', ${T})`,
  "INSERT INTO composition_contributor_roles (contributor_id, role) VALUES ('ctr_jordan', 'songwriter'), ('ctr_alex', 'composer'), ('ctr_alex', 'lyricist')",
  "INSERT INTO recording_artists (id, recording_id, party_id, artist_alias_id, role) VALUES ('ra_ocean', 'rec_ocean', 'pty_jordan', 'ali_jt', 'primary')",
  `INSERT INTO master_interests (id, recording_id, owner_party_id, share_bp, created_at, updated_at) VALUES ('mi_ocean', 'rec_ocean', 'pty_northstar', 10000, ${T})`,
  `INSERT INTO contacts (id, party_id, created_at, updated_at) VALUES ('con_sam', 'pty_sam', ${T})`,
  `INSERT INTO pitches (id, contact_id, created_at, updated_at) VALUES ('pit_1', 'con_sam', ${T}), ('pit_2', 'con_sam', ${T})`,
  `INSERT INTO pitch_items (id, pitch_id, composition_id, recording_id, created_at, updated_at) VALUES ('pti_1_ocean', 'pit_1', NULL, 'rec_ocean', ${T}), ('pti_2_ocean', 'pit_2', 'cmp_ocean', NULL, ${T}), ('pti_2_demo', 'pit_2', NULL, 'rec_demo', ${T})`,
];

/** A migrated workspace database with foreign keys off, holding SEED. */
async function seeded() {
  const db = await openWithoutForeignKeys((fresh) =>
    applyWorkspaceMigrations((fresh as LibSQLDatabase & { $client: Client }).$client),
  );
  onTestFinished(() => db.$client.close());
  await expectForeignKeysIntact(db, async (tx) => {
    for (const statement of SEED) await tx.run(sql.raw(statement));
  });
  return db;
}

describe('DAT-INT-001: workspaceIntegrityGuard keeps a workspace consistent with foreign keys off', () => {
  it('deletes a composition_contributors row with its composition_contributor_roles rows', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.delete(tx, compositionContributors, eq(compositionContributors.id, 'ctr_alex'));
      expect(await tx.select().from(compositionContributorRoles)).toEqual([
        { contributorId: 'ctr_jordan', role: 'songwriter' },
      ]);
    });
  });

  it('deleting an artist alias sets recording_artists and party_identifiers artist_alias_id to NULL', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.delete(tx, artistAliases, eq(artistAliases.id, 'ali_jt'));
      const credited = { id: recordingArtists.id, alias: recordingArtists.artistAliasId };
      expect(await tx.select(credited).from(recordingArtists)).toEqual([
        { id: 'ra_ocean', alias: null },
      ]);
      const identified = { id: partyIdentifiers.id, alias: partyIdentifiers.artistAliasId };
      expect(await tx.select(identified).from(partyIdentifiers)).toEqual([
        { id: 'pid_jt', alias: null },
      ]);
    });
  });

  it('refuses changing parties.party_kind for a party that is still a writer', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const change = guard.update(
        tx,
        parties,
        { partyKind: 'organization' },
        eq(parties.id, 'pty_jordan'),
      );
      await expect(change).rejects.toMatchObject({
        code: 'REFERENCED',
        table: 'parties',
        counts: { composition_contributors: 1 },
      });
    });
  });

  it('refuses a new reference to a soft-deleted recording', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.softDelete(tx, recordings, eq(recordings.id, 'rec_night'));
      const master = { id: 'mi_night', recordingId: 'rec_night', ownerPartyId: 'pty_northstar' };
      const insert = guard.insert(tx, masterInterests, [{ ...master, shareBp: 10000, ...STAMPS }]);
      await expect(insert).rejects.toMatchObject({ code: 'NOT_FOUND', counts: { recordings: 1 } });
    });
  });

  it('refuses soft-deleting a party a master interest references', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const northstar = eq(parties.id, 'pty_northstar');
      await expect(guard.softDelete(tx, parties, northstar)).rejects.toMatchObject({
        code: 'REFERENCED',
        table: 'parties',
        counts: { master_interests: 1 },
      });
      const [row] = await tx
        .select({ deletedAt: parties.deletedAt })
        .from(parties)
        .where(northstar);
      expect(row).toEqual({ deletedAt: null });
    });
  });

  it('soft-deletes an unreferenced composition and throws for a table without deleted_at', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.softDelete(tx, compositions, eq(compositions.id, 'cmp_spare'));
      const { id, deletedAt, updatedAt } = compositions;
      const rows = await tx.select({ id, deletedAt, updatedAt }).from(compositions);
      const [spare] = rows.filter((row) => row.id === 'cmp_spare');
      expect(spare.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(spare.updatedAt).toBe(spare.deletedAt);
      expect(rows.filter((row) => row.deletedAt !== null)).toEqual([spare]);
      const masters = guard.softDelete(tx, masterInterests, eq(masterInterests.id, 'mi_ocean'));
      await expect(masters).rejects.toThrow('master_interests has no column deleted_at');
    });
  });
});

describe('DAT-INT-001: workspaceIntegrityGuard holds a song at one level per pitch (§4.4 rule 3)', () => {
  const cell = (id: string, pitchId: string, target: object) => ({
    id,
    pitchId,
    ...target,
    ...STAMPS,
  });
  const conflict = (table: string) => ({
    code: 'SONG_LEVEL_CONFLICT',
    table,
    counts: { [table]: 1 },
  });

  it('refuses a composition cell in a pitch holding one of its recordings, and the reverse, before the triggers', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const composition = cell('pti_1_cmp', 'pit_1', { compositionId: 'cmp_ocean' });
      const recording = cell('pti_2_rec', 'pit_2', { recordingId: 'rec_ocean' });
      for (const refused of [[composition], [recording]]) {
        await expect(guard.insert(tx, pitchItems, refused)).rejects.toMatchObject(
          conflict('pitch_items'),
        );
      }
      // Both levels in one insert: the second cell conflicts with the first.
      const both = [
        cell('pti_1_night', 'pit_1', { compositionId: 'cmp_night' }),
        cell('pti_1_demo', 'pit_1', { recordingId: 'rec_demo' }),
      ];
      await expect(guard.insert(tx, pitchItems, both)).rejects.toMatchObject(
        conflict('pitch_items'),
      );
      await guard.insert(tx, pitchItems, both.slice(0, 1));
      const ids = await tx.select({ id: pitchItems.id }).from(pitchItems);
      expect(ids.map((row) => row.id).sort()).toEqual([
        'pti_1_night',
        'pti_1_ocean',
        'pti_2_demo',
        'pti_2_ocean',
      ]);
    });
  });

  it('refuses moving a recording to a composition a pitch holding the recording also holds', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const demo = eq(recordings.id, 'rec_demo');
      const move = guard.update(tx, recordings, { compositionId: 'cmp_ocean' }, demo);
      await expect(move).rejects.toMatchObject(conflict('recordings'));
      await guard.update(tx, recordings, { compositionId: 'cmp_spare' }, demo);
      const [row] = await tx
        .select({ compositionId: recordings.compositionId })
        .from(recordings)
        .where(demo);
      expect(row).toEqual({ compositionId: 'cmp_spare' });
    });
  });
});
