import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_MIGRATIONS,
  FK_RULES_FILE,
  generateForeignKeyRules,
} from '../../src/server/db/fk-rules';
import { FOREIGN_KEY_RULES } from '../../src/server/db/fk-rules.generated';
import { WORKSPACE_MIGRATIONS } from '../../src/server/db/workspace-migrations';
import { addPitchOwner, generateFromChangedCopy, replaceIn } from './changed-migrations';

/** Generates from a copy of the control migrations that `change` edits first. */
function generateFromChangedMigrations(change: (folder: string) => void) {
  return generateFromChangedCopy(CONTROL_MIGRATIONS, change, generateForeignKeyRules);
}

/** Generates from a copy of the workspace migrations that `change` edits first. */
function generateFromChangedWorkspace(change: (folder: string) => void) {
  return generateFromChangedCopy(WORKSPACE_MIGRATIONS, change, (folder) =>
    generateForeignKeyRules(CONTROL_MIGRATIONS, folder),
  );
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

describe('DAT-001: foreign-key rules are generated from the migrated workspace schema', () => {
  const committed = readFileSync(FK_RULES_FILE, 'utf8');
  const rule = (table: string, columns: string[], parentTable: string, onDelete: string) =>
    [
      `      table: '${table}',`,
      `      columns: [${columns.map((column) => `'${column}'`).join(', ')}],`,
      `      parentTable: '${parentTable}',`,
      "      parentColumns: ['id'],",
      `      onDelete: '${onDelete}',`,
    ].join('\n');

  it('covers every workspace table that declares a foreign key', () => {
    const tables =
      'agreements artist_aliases asset_credits composition_alt_titles composition_assets composition_contributor_roles composition_contributors composition_registrations composition_terms contact_methods contact_roles contacts external_references generated_report_items generated_reports import_issues import_runs licensing_contacts master_interests message_recipients messages organizations party_identifiers party_society_affiliations people pitch_events pitch_items pitches publishing_interests recording_artists recording_assets recording_contributors recording_links recording_registrations recording_terms recordings release_assets release_tracks releases workspace_self_parties';
    expect(new Set(FOREIGN_KEY_RULES.workspace.map(({ table }) => table))).toEqual(
      new Set(tables.split(' ')),
    );
  });

  it('keeps the kind-checked writer key to parties as one composite rule', () => {
    const writerParty = FOREIGN_KEY_RULES.workspace.filter(
      ({ table, parentTable }) => table === 'composition_contributors' && parentTable === 'parties',
    );
    expect(writerParty).toEqual([
      {
        table: 'composition_contributors',
        columns: ['party_id', 'party_kind'],
        parentTable: 'parties',
        parentColumns: ['id', 'party_kind'],
        onDelete: 'RESTRICT',
        onUpdate: 'NO ACTION',
      },
    ]);
  });

  it('drifts when a workspace migration adds a column with a foreign key', async () => {
    const generated = await generateFromChangedWorkspace(addPitchOwner);
    expect(generated).not.toBe(committed);
    expect(generated).toContain(rule('pitches', ['owner_party_id'], 'parties', 'SET NULL'));
  });

  it('drifts when a workspace migration changes a foreign-key action', async () => {
    const restrictContact =
      /(contact_id\s+TEXT NOT NULL REFERENCES contacts\(id\) ON DELETE) RESTRICT/;
    const change = replaceIn(
      '0003_crm_pitches_messages_reports.sql',
      restrictContact,
      '$1 CASCADE',
    );
    const generated = await generateFromChangedWorkspace(change);
    expect(generated).not.toBe(committed);
    expect(generated).toContain(rule('pitches', ['contact_id'], 'contacts', 'CASCADE'));
  });
});
