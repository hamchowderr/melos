import type { Client } from '@libsql/client';
import { eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  artistAliases,
  compositionContributorRoles,
  compositionContributors,
  compositions,
  contacts,
  masterInterests,
  parties,
  pitchItems,
  recordings,
} from '../../src/server/db/schema/workspace.generated';
import { applyWorkspaceMigrations } from '../../src/server/db/workspace-migrations';
import { workspaceIntegrityGuard as guard } from '../../src/server/services/integrity-guard';
import { expectForeignKeysIntact, openWithoutForeignKeys } from './support';

const AT = '2026-09-13T00:00:00.000Z';
const STAMPS = { createdAt: AT, updatedAt: AT };
const T = `'${AT}', '${AT}'`;
const ACTOR = 'usr_jordan';

// Jordan and Alex write Ocean Blue; Jordan records it as JT; Northstar owns its master. Sam is a
// contact with two pitches: pit_1 holds the Ocean Blue recording, pit_2 the composition and a demo
// recording of Night Drive. Kim is a contact and Draft a song, both without pitches or rights.
const SEED = [
  `INSERT INTO parties (id, party_kind, display_name, created_at, updated_at) VALUES ('pty_jordan', 'person', 'Jordan', ${T}), ('pty_alex', 'person', 'Alex', ${T}), ('pty_northstar', 'organization', 'Northstar', ${T}), ('pty_sam', 'person', 'Sam', ${T}), ('pty_kim', 'person', 'Kim', ${T})`,
  `INSERT INTO artist_aliases (id, party_id, alias_name, created_at) VALUES ('ali_jt', 'pty_jordan', 'JT', '${AT}')`,
  `INSERT INTO party_identifiers (id, party_id, artist_alias_id, identifier_type, identifier_value, created_at) VALUES ('pid_jt', 'pty_jordan', 'ali_jt', 'IPI', '00000000001', '${AT}')`,
  `INSERT INTO compositions (id, title, created_at, updated_at) VALUES ('cmp_ocean', 'Ocean Blue', ${T}), ('cmp_night', 'Night Drive', ${T}), ('cmp_spare', 'Spare', ${T}), ('cmp_draft', 'Draft', ${T})`,
  `INSERT INTO recordings (id, composition_id, title, created_at, updated_at) VALUES ('rec_ocean', 'cmp_ocean', 'Ocean Blue', ${T}), ('rec_night', 'cmp_night', 'Night Drive', ${T}), ('rec_demo', 'cmp_night', 'Night Drive (demo)', ${T}), ('rec_draft', 'cmp_draft', 'Draft', ${T})`,
  `INSERT INTO composition_contributors (id, composition_id, party_id, created_at, updated_at) VALUES ('ctr_jordan', 'cmp_ocean', 'pty_jordan', ${T}), ('ctr_alex', 'cmp_ocean', 'pty_alex', ${T})`,
  "INSERT INTO composition_contributor_roles (contributor_id, role) VALUES ('ctr_jordan', 'songwriter'), ('ctr_alex', 'composer'), ('ctr_alex', 'lyricist')",
  "INSERT INTO recording_artists (id, recording_id, party_id, artist_alias_id, role) VALUES ('ra_ocean', 'rec_ocean', 'pty_jordan', 'ali_jt', 'primary')",
  `INSERT INTO master_interests (id, recording_id, owner_party_id, share_bp, created_at, updated_at) VALUES ('mi_ocean', 'rec_ocean', 'pty_northstar', 10000, ${T})`,
  `INSERT INTO contacts (id, party_id, created_at, updated_at) VALUES ('con_sam', 'pty_sam', ${T}), ('con_kim', 'pty_kim', ${T})`,
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
      const roles = await tx.select().from(compositionContributorRoles);
      expect(roles).toEqual([{ contributorId: 'ctr_jordan', role: 'songwriter' }]);
    });
  });

  it('deleting an artist alias sets recording_artists and party_identifiers artist_alias_id to NULL', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.delete(tx, artistAliases, eq(artistAliases.id, 'ali_jt'));
      const aliases = sql`SELECT id, artist_alias_id AS alias FROM recording_artists UNION ALL SELECT id, artist_alias_id FROM party_identifiers`;
      const cleared = [
        { id: 'ra_ocean', alias: null },
        { id: 'pid_jt', alias: null },
      ];
      expect(await tx.all(aliases)).toEqual(cleared);
    });
  });

  it('refuses changing parties.party_kind for a party that is still a writer', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const jordan = eq(parties.id, 'pty_jordan');
      const change = guard.update(tx, parties, { partyKind: 'organization' }, jordan);
      const counts = { composition_contributors: 1 };
      await expect(change).rejects.toMatchObject({ code: 'REFERENCED', table: 'parties', counts });
    });
  });

  it('refuses a new reference to a soft-deleted recording', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.softDelete(tx, recordings, eq(recordings.id, 'rec_night'), ACTOR);
      const master = { id: 'mi_night', recordingId: 'rec_night', ownerPartyId: 'pty_northstar' };
      const insert = guard.insert(tx, masterInterests, [{ ...master, shareBp: 10000, ...STAMPS }]);
      await expect(insert).rejects.toMatchObject({ code: 'NOT_FOUND', counts: { recordings: 1 } });
    });
  });

  it('refuses soft-deleting a party a master interest references', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const northstar = eq(parties.id, 'pty_northstar');
      const refusal = { code: 'REFERENCED', table: 'parties', counts: { master_interests: 1 } };
      await expect(guard.softDelete(tx, parties, northstar, ACTOR)).rejects.toMatchObject(refusal);
      const rows = await tx.all(sql`SELECT deleted_at FROM parties WHERE id = 'pty_northstar'`);
      expect(rows).toEqual([{ deleted_at: null }]);
    });
  });

  it('soft-deletes a composition after its recording and a party after its contact, and still refuses a hard delete', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const draft = eq(compositions.id, 'cmp_draft');
      const refusal = { code: 'REFERENCED', table: 'compositions', counts: { recordings: 1 } };
      // A live recording blocks the soft delete; a soft-deleted one no longer does.
      await expect(guard.softDelete(tx, compositions, draft, ACTOR)).rejects.toMatchObject(refusal);
      await guard.softDelete(tx, recordings, eq(recordings.id, 'rec_draft'), ACTOR);
      await guard.softDelete(tx, compositions, draft, ACTOR);
      await guard.softDelete(tx, contacts, eq(contacts.id, 'con_kim'), ACTOR);
      await guard.softDelete(tx, parties, eq(parties.id, 'pty_kim'), ACTOR);
      // The soft-deleted recording still references the composition a hard delete would remove.
      await expect(guard.delete(tx, compositions, draft)).rejects.toMatchObject(refusal);
      const tables = ['compositions', 'recordings', 'contacts', 'parties'];
      const deleted = tables.map((table) => `SELECT id FROM ${table} WHERE deleted_at IS NOT NULL`);
      const ids = await tx.all<{ id: string }>(sql.raw(deleted.join(' UNION ALL ')));
      expect(ids.map((row) => row.id)).toEqual(['cmp_draft', 'rec_draft', 'con_kim', 'pty_kim']);
    });
  });

  it('soft-deletes an unreferenced composition as the actor and throws for a table without deleted_at', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.softDelete(tx, compositions, eq(compositions.id, 'cmp_spare'), ACTOR);
      const { id, deletedAt, updatedAt, updatedBy } = compositions;
      const rows = await tx.select({ id, deletedAt, updatedAt, updatedBy }).from(compositions);
      const [spare] = rows.filter((row) => row.id === 'cmp_spare');
      expect(spare.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(spare).toMatchObject({ updatedAt: spare.deletedAt, updatedBy: ACTOR });
      expect(rows.filter((row) => row.deletedAt !== null)).toEqual([spare]);
      const master = eq(masterInterests.id, 'mi_ocean');
      const masters = guard.softDelete(tx, masterInterests, master, ACTOR);
      await expect(masters).rejects.toThrow('master_interests has no column deleted_at');
    });
  });
});

describe('DAT-INT-001: workspaceIntegrityGuard holds a song at one level per pitch (§4.4 rule 3)', () => {
  const cell = (id: string, pitchId: string, at: object) => ({ id, pitchId, ...at, ...STAMPS });
  const conflict = (table: string) => ({ code: 'SONG_LEVEL_CONFLICT', counts: { [table]: 1 } });
  const cellConflict = conflict('pitch_items');

  it('refuses a composition cell in a pitch holding one of its recordings, and the reverse, before the triggers', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const composition = cell('pti_1_cmp', 'pit_1', { compositionId: 'cmp_ocean' });
      const recording = cell('pti_2_rec', 'pit_2', { recordingId: 'rec_ocean' });
      for (const refused of [[composition], [recording]]) {
        await expect(guard.insert(tx, pitchItems, refused)).rejects.toMatchObject(cellConflict);
      }
      // Both levels in one insert, in either order: the second cell conflicts with the first.
      const night = cell('pti_1_night', 'pit_1', { compositionId: 'cmp_night' });
      const demo = cell('pti_1_demo', 'pit_1', { recordingId: 'rec_demo' });
      const pair = [night, demo];
      for (const both of [pair, [...pair].reverse()]) {
        await expect(guard.insert(tx, pitchItems, both)).rejects.toMatchObject(cellConflict);
      }
      const empty = guard.insert(tx, pitchItems, []);
      await expect(empty).rejects.toThrow('values() must be called with at least one value');
      await guard.insert(tx, pitchItems, [night]);
      const pit1 = sql`SELECT id FROM pitch_items WHERE pitch_id = 'pit_1' ORDER BY id`;
      expect(await tx.all(pit1)).toEqual([{ id: 'pti_1_night' }, { id: 'pti_1_ocean' }]);
    });
  });

  it('refuses moving a recording to a composition a pitch holding the recording also holds', async () => {
    const db = await seeded();
    await expectForeignKeysIntact(db, async (tx) => {
      const demo = eq(recordings.id, 'rec_demo');
      const move = guard.update(tx, recordings, { compositionId: 'cmp_ocean' }, demo);
      await expect(move).rejects.toMatchObject(conflict('recordings'));
      await guard.update(tx, recordings, { compositionId: 'cmp_spare' }, demo);
      const moved = await tx.all(sql`SELECT composition_id FROM recordings WHERE id = 'rec_demo'`);
      expect(moved).toEqual([{ composition_id: 'cmp_spare' }]);
    });
  });
});
