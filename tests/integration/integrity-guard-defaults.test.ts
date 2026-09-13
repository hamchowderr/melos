import { eq, sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createIntegrityGuard } from '../../src/server/services/integrity-guard';
import { expectForeignKeysIntact, openWithoutForeignKeys } from './support';

const FIXTURE = [
  'CREATE TABLE folders (id TEXT PRIMARY KEY, kind TEXT NOT NULL, UNIQUE (id, kind))',
  'CREATE TABLE notes (id TEXT PRIMARY KEY, folder_id TEXT, folder_kind TEXT, FOREIGN KEY (folder_id, folder_kind) REFERENCES folders (id, kind))',
];
const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
});
// drizzle fills folder_kind when a write leaves it out: 'group' on insert and on update.
const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  folderId: text('folder_id'),
  folderKind: text('folder_kind')
    .$defaultFn(() => 'group')
    .$onUpdate(() => 'group'),
});
const guard = createIntegrityGuard([
  {
    table: 'notes',
    columns: ['folder_id', 'folder_kind'],
    parentTable: 'folders',
    parentColumns: ['id', 'kind'],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
  },
]);

describe('DAT-INT-001: IntegrityGuard checks the composite key a write stores', () => {
  it('refuses a key whose omitted column drizzle fills from a default or update function', async () => {
    const db = await openWithoutForeignKeys(async (fresh) => {
      for (const statement of FIXTURE) await fresh.run(sql.raw(statement));
    });
    onTestFinished(() => db.$client.close());
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.insert(tx, folders, [{ id: 'f1', kind: 'person' }]);
      await guard.insert(tx, notes, [{ id: 'n1', folderId: null, folderKind: 'person' }]);
      const notFound = { code: 'NOT_FOUND', table: 'notes', counts: { folders: 1 } };
      const inserted = guard.insert(tx, notes, [{ id: 'n2', folderId: 'f1' }]);
      await expect(inserted).rejects.toMatchObject(notFound);
      const moved = guard.update(tx, notes, { folderId: 'f1' }, eq(notes.id, 'n1'));
      await expect(moved).rejects.toMatchObject(notFound);
      expect(await tx.select().from(notes)).toEqual([
        { id: 'n1', folderId: null, folderKind: 'person' },
      ]);
    });
  });
});
