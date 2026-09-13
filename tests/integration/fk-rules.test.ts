import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_MIGRATIONS,
  FK_RULES_FILE,
  generateForeignKeyRules,
} from '../../src/server/db/fk-rules';
import { FOREIGN_KEY_RULES } from '../../src/server/db/fk-rules.generated';

/** Generates from a copy of the control migrations that `change` edits first. */
async function generateFromChangedMigrations(change: (folder: string) => void) {
  const folder = mkdtempSync(join(tmpdir(), 'melos-fk-migrations-'));
  try {
    cpSync(CONTROL_MIGRATIONS, folder, { recursive: true });
    change(folder);
    return await generateForeignKeyRules(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

describe('DAT-001: foreign-key rules are generated from the migrated control schema', () => {
  const committed = readFileSync(FK_RULES_FILE, 'utf8');

  it('matches a fresh generation byte for byte', async () => {
    expect(await generateForeignKeyRules()).toBe(committed);
  });

  it('covers the Better Auth and control tables', () => {
    expect(new Set(FOREIGN_KEY_RULES.control.map((rule) => rule.table))).toEqual(
      new Set([
        'account',
        'invitation',
        'member',
        'migration_runs',
        'session',
        'workspace_member_settings',
        'workspace_registry',
      ]),
    );
  });

  it('drifts when a migration changes a foreign-key action', async () => {
    const generated = await generateFromChangedMigrations((folder) => {
      const file = join(folder, '0001_control_plane_tables.sql');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace('ON DELETE restrict', 'ON DELETE set null'),
      );
    });
    expect(generated).not.toBe(committed);
    expect(generated).toContain(
      "parentTable: 'organization',\n      parentColumns: ['id'],\n      onDelete: 'SET NULL',",
    );
  });

  it('drifts when a migration adds a foreign key, and keeps a composite key as one rule', async () => {
    const generated = await generateFromChangedMigrations((folder) => {
      const journalFile = join(folder, 'meta/_journal.json');
      const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
      const last = journal.entries.at(-1);
      const tag = '0003_member_notes';
      journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag });
      writeFileSync(journalFile, JSON.stringify(journal));
      appendFileSync(
        join(folder, `${tag}.sql`),
        'CREATE TABLE member_notes (id TEXT PRIMARY KEY, organization_id TEXT, user_id TEXT, ' +
          'FOREIGN KEY (organization_id, user_id) REFERENCES workspace_member_settings (organization_id, user_id) ON DELETE SET NULL);',
      );
    });
    expect(generated).not.toBe(committed);
    expect(generated).toContain(
      [
        "      table: 'member_notes',",
        "      columns: ['organization_id', 'user_id'],",
        "      parentTable: 'workspace_member_settings',",
        "      parentColumns: ['organization_id', 'user_id'],",
        "      onDelete: 'SET NULL',",
        "      onUpdate: 'NO ACTION',",
      ].join('\n'),
    );
  });
});
