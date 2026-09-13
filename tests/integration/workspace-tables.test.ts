import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrateWorkspace, readMigrated } from '../../src/server/db/fk-rules';
import { FOREIGN_KEY_RULES } from '../../src/server/db/fk-rules.generated';
import {
  compositionContributors,
  compositions,
  parties,
  WORKSPACE_TABLES,
} from '../../src/server/db/schema/workspace.generated';
import {
  applyWorkspaceMigrations,
  WORKSPACE_MIGRATIONS,
} from '../../src/server/db/workspace-migrations';
import {
  generateWorkspaceTables,
  WORKSPACE_TABLES_FILE,
} from '../../src/server/db/workspace-tables';
import { createIntegrityGuard } from '../../src/server/services/integrity-guard';
import { addPitchOwner, generateFromChangedCopy, replaceIn } from './changed-migrations';
import { expectForeignKeysIntact, openWithoutForeignKeys } from './support';

const AT = '2026-09-13T00:00:00.000Z';
const STAMPS = { createdAt: AT, updatedAt: AT };

/** Generates from a copy of the workspace migrations that `change` edits first. */
function generateFromChangedWorkspace(change: (folder: string) => void) {
  return generateFromChangedCopy(WORKSPACE_MIGRATIONS, change, generateWorkspaceTables);
}

describe('DAT-001: workspace Drizzle tables are generated from the migrated workspace schema', () => {
  const committed = readFileSync(WORKSPACE_TABLES_FILE, 'utf8');

  it('matches a fresh generation byte for byte', async () => {
    expect(await generateWorkspaceTables()).toBe(committed);
  });

  it('defines every workspace table but schema_migrations and catalog_search, by SQL name, with its SQL column names in order', async () => {
    // sqlite_master, not the generator's pragma_table_list, so a wrong type filter fails here.
    const migrated = await readMigrated(migrateWorkspace(WORKSPACE_MIGRATIONS), async (client) => {
      const { rows } = await client.execute(
        "SELECT m.name AS tbl, p.name AS col FROM sqlite_master AS m JOIN pragma_table_info(m.name) AS p WHERE m.type = 'table' AND m.name != 'schema_migrations' AND m.name NOT LIKE 'catalog\\_search%' ESCAPE '\\' ORDER BY m.name, p.cid",
      );
      const byTable = Map.groupBy(rows, (row) => String(row.tbl));
      return Object.fromEntries(
        [...byTable].map(([table, columns]) => [table, columns.map((row) => String(row.col))]),
      );
    });
    const generated = Object.entries(WORKSPACE_TABLES).map(([name, table]) => [
      name,
      getTableName(table),
      Object.values(getTableColumns(table)).map((column) => column.name),
    ]);
    expect(generated.map(([name, sqlName]) => [name, sqlName])).toEqual(
      generated.map(([name]) => [name, name]),
    );
    expect(Object.fromEntries(generated.map(([name, , columns]) => [name, columns]))).toEqual(
      migrated,
    );
  });

  it('drifts when a workspace migration adds a column', async () => {
    const generated = await generateFromChangedWorkspace(addPitchOwner);
    expect(generated).not.toBe(committed);
    expect(generated).toContain(
      "  updatedBy: text('updated_by'),\n  ownerPartyId: text('owner_party_id'),\n});",
    );
  });

  it('drifts when a workspace migration changes a column', async () => {
    const change = replaceIn('0001_parties_catalog.sql', "DEFAULT 'stage_name'", "DEFAULT 'aka'");
    const generated = await generateFromChangedWorkspace(change);
    expect(generated).not.toBe(committed);
    expect(generated).toContain("aliasType: text('alias_type').notNull().default('aka'),");
  });
});

describe('DAT-INT-001: IntegrityGuard writes workspace rows through the generated tables', () => {
  it('refuses a writer whose party is an organization, with party_kind given or left to its default, and inserts one whose party is a person', async () => {
    const db = await openWithoutForeignKeys((fresh) =>
      // drizzle() hands back its client as $client, which the LibSQLDatabase type leaves out.
      applyWorkspaceMigrations((fresh as LibSQLDatabase & { $client: Client }).$client),
    );
    onTestFinished(() => db.$client.close());
    const guard = createIntegrityGuard(FOREIGN_KEY_RULES.workspace);
    await expectForeignKeysIntact(db, async (tx) => {
      await guard.insert(tx, parties, [
        { id: 'pty_writer', partyKind: 'person', displayName: 'Jordan Taylor', ...STAMPS },
        { id: 'pty_label', partyKind: 'organization', displayName: 'Northstar', ...STAMPS },
      ]);
      await guard.insert(tx, compositions, [{ id: 'cmp_song', title: 'Ocean Blue', ...STAMPS }]);
      // party_kind is left to its default, 'person', which the guard checks as the stored key.
      const writer = (id: string, partyId: string) => ({
        id,
        compositionId: 'cmp_song',
        partyId,
        writerShareBp: 10000,
        ...STAMPS,
      });
      const label = writer('ctr_label', 'pty_label');
      const refusal = {
        code: 'NOT_FOUND',
        table: 'composition_contributors',
        counts: { parties: 1 },
      };
      for (const refused of [label, { ...label, partyKind: 'person' }]) {
        const insert = guard.insert(tx, compositionContributors, [refused]);
        await expect(insert).rejects.toMatchObject(refusal);
      }
      await guard.insert(tx, compositionContributors, [writer('ctr_writer', 'pty_writer')]);
      const { id, partyId, partyKind } = compositionContributors;
      const writers = await tx.select({ id, partyId, partyKind }).from(compositionContributors);
      expect(writers).toEqual([{ id: 'ctr_writer', partyId: 'pty_writer', partyKind: 'person' }]);
    });
  });
});
