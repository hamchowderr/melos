import { eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { organization, user } from '../../src/server/db/schema/auth';
import { workspaceMemberSettings, workspaceRegistry } from '../../src/server/db/schema/control';
import * as integrity from '../../src/server/services/integrity-guard';
import { expectForeignKeysIntact, openWithoutForeignKeys } from './support';

const guard = integrity.controlIntegrityGuard;
const iso = '2026-09-12T00:00:00.000Z';
let control: Awaited<ReturnType<typeof openWithoutForeignKeys>>;

// usr_1 invited usr_2 to org_1. Both have a session, an account, a member row and settings.
const SEED = [
  "INSERT INTO organization (id, name, slug, created_at) VALUES ('org_1', 'One', 'one', 0)",
  "INSERT INTO user (id, name, email) VALUES ('usr_1', 'One', '1@example.test'), ('usr_2', 'Two', '2@example.test')",
  "INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES ('ses_1', 't1', 'usr_1', 0, 0), ('ses_2', 't2', 'usr_2', 0, 0)",
  "INSERT INTO account (id, account_id, provider_id, user_id, updated_at) VALUES ('acc_1', 'a1', 'credential', 'usr_1', 0), ('acc_2', 'a2', 'credential', 'usr_2', 0)",
  "INSERT INTO member (id, organization_id, user_id, created_at) VALUES ('mem_1', 'org_1', 'usr_1', 0), ('mem_2', 'org_1', 'usr_2', 0)",
  `INSERT INTO workspace_member_settings (organization_id, user_id, updated_at) VALUES ('org_1', 'usr_1', '${iso}'), ('org_1', 'usr_2', '${iso}')`,
  "INSERT INTO invitation (id, organization_id, email, expires_at, inviter_id) VALUES ('inv_1', 'org_1', '3@example.test', 0, 'usr_1')",
  `INSERT INTO workspace_registry (id, organization_id, database_name, database_url, created_at, updated_at) VALUES ('ws_1', 'org_1', 'melos-ws-1', 'file:./ws.db', '${iso}', '${iso}')`,
  "INSERT INTO migration_runs (id, batch_id, workspace_id, from_version, to_version, status) VALUES ('mig_1', 'b1', 'ws_1', 0, 1, 'succeeded')",
];

async function expectRowCounts(db: LibSQLDatabase, expected: Record<string, number>) {
  const counts: Record<string, number> = {};
  for (const table of Object.keys(expected)) {
    const query = sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`;
    [{ n: counts[table] }] = await db.all<{ n: number }>(query);
  }
  expect(counts).toEqual(expected);
}

beforeAll(async () => {
  const migrationsFolder = './src/server/db/migrations/control';
  control = await openWithoutForeignKeys((db) => migrate(db, { migrationsFolder }));
  await expectForeignKeysIntact(control, async (tx) => {
    for (const statement of SEED) await tx.run(sql.raw(statement));
  });
});

afterAll(() => control?.$client.close());

describe('DAT-INT-001: IntegrityGuard keeps melos-control consistent with foreign keys off', () => {
  it('refuses a workspace_member_settings row for a missing user or organization', async () => {
    await expectForeignKeysIntact(control, async (tx) => {
      const orphans = [
        [{ organizationId: 'org_1', userId: 'usr_missing', updatedAt: iso }, { user: 1 }],
        [{ organizationId: 'org_missing', userId: 'usr_1', updatedAt: iso }, { organization: 1 }],
      ] as const;
      for (const [row, counts] of orphans) {
        const refused = guard.insert(tx, workspaceMemberSettings, [row]);
        await expect(refused).rejects.toMatchObject({ code: 'NOT_FOUND', counts });
      }
    });
    await expectRowCounts(control, { workspace_member_settings: 2 });
  });

  it('refuses deleting an organization a workspace_registry row references, rolling back the transaction', async () => {
    const refused = expectForeignKeysIntact(control, async (tx) => {
      await guard.delete(tx, user, eq(user.id, 'usr_2'));
      await guard.delete(tx, organization, eq(organization.id, 'org_1'));
    });
    const refusal = {
      code: 'REFERENCED',
      table: 'organization',
      counts: { workspace_registry: 1 },
    };
    await expect(refused).rejects.toMatchObject(refusal);
    await expectRowCounts(control, { user: 2, member: 2, organization: 1 });
  });

  it('cascades a user delete to its sessions, accounts, members, invitations and settings', async () => {
    await expectForeignKeysIntact(control, (tx) => guard.delete(tx, user, eq(user.id, 'usr_1')));
    const left = { session: 1, account: 1, member: 1, invitation: 0, workspace_member_settings: 1 };
    await expectRowCounts(control, left);
  });

  it('deletes an organization once its workspace_registry row and migration runs are gone', async () => {
    await expectForeignKeysIntact(control, async (tx) => {
      await guard.delete(tx, workspaceRegistry, eq(workspaceRegistry.id, 'ws_1'));
      await guard.delete(tx, organization, eq(organization.id, 'org_1'));
    });
    const left = { migration_runs: 0, organization: 0, member: 0, workspace_member_settings: 0 };
    await expectRowCounts(control, { ...left, user: 1 });
  });
});

// A test-only composite key, shaped like the workspace kind checks against parties(id, party_kind).
const FIXTURE = [
  'CREATE TABLE folders (id TEXT PRIMARY KEY, kind TEXT NOT NULL, deleted_at TEXT, UNIQUE (id, kind))',
  'CREATE TABLE notes (id TEXT PRIMARY KEY, folder_id TEXT, folder_kind TEXT, FOREIGN KEY (folder_id, folder_kind) REFERENCES folders (id, kind) ON DELETE SET NULL)',
];
const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  deletedAt: text('deleted_at'),
});
const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  folderId: text('folder_id'),
  folderKind: text('folder_kind'),
});
const composite = integrity.createIntegrityGuard([
  {
    table: 'notes',
    columns: ['folder_id', 'folder_kind'],
    parentTable: 'folders',
    parentColumns: ['id', 'kind'],
    onDelete: 'SET NULL',
    onUpdate: 'NO ACTION',
  },
]);

describe('DAT-INT-001: IntegrityGuard handles composite keys', () => {
  it('checks a composite key only when no column is NULL, never against a soft-deleted parent', async () => {
    const db = await openWithoutForeignKeys(async (fresh) => {
      for (const statement of FIXTURE) await fresh.run(sql.raw(statement));
    });
    onTestFinished(() => db.$client.close());
    await expectForeignKeysIntact(db, async (tx) => {
      await composite.insert(tx, folders, [
        { id: 'f1', kind: 'person' },
        { id: 'f2', kind: 'person', deletedAt: iso },
      ]);
      await composite.insert(tx, notes, [
        { id: 'n1', folderId: 'missing', folderKind: null },
        { id: 'n2', folderId: 'f1', folderKind: 'person' },
      ]);
      const notFound = { code: 'NOT_FOUND', counts: { folders: 1 } };
      const wrongKind = { id: 'n3', folderId: 'f1', folderKind: 'group' };
      await expect(composite.insert(tx, notes, [wrongKind])).rejects.toMatchObject(notFound);
      const softDeleted = { id: 'n3', folderId: 'f2', folderKind: 'person' };
      await expect(composite.insert(tx, notes, [softDeleted])).rejects.toMatchObject(notFound);
      const partial = composite.update(tx, notes, { folderKind: 'group' }, eq(notes.id, 'n2'));
      await expect(partial).rejects.toMatchObject(notFound);
      const reclassify = composite.update(tx, folders, { kind: 'group' }, eq(folders.id, 'f1'));
      await expect(reclassify).rejects.toMatchObject({ code: 'REFERENCED', counts: { notes: 1 } });

      await composite.delete(tx, folders, eq(folders.id, 'f1'));
      expect(await tx.select().from(notes)).toEqual([
        { id: 'n1', folderId: 'missing', folderKind: null },
        { id: 'n2', folderId: null, folderKind: null },
      ]);
    });
  });
});
