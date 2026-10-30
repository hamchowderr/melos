import { readFileSync, rmSync } from 'node:fs';
import { type Client, createClient, type InStatement } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureLocalDatabaseDir } from '../../src/server/db/local-database';
import {
  applyWorkspaceMigrations,
  readSchemaVersion,
  readWorkspaceMigrations,
} from '../../src/server/db/workspace-migrations';

const AT = '2026-09-13T00:00:00.000Z';
const STAMPS = { created_at: AT, updated_at: AT };
const FK = 'FOREIGN KEY constraint failed';
const CHECK = 'CHECK constraint failed';
const clients: Client[] = [];

/** One connection, and no file for Windows to keep locked. */
function memoryDatabase(): Client {
  const client = createClient({ url: ':memory:' });
  clients.push(client);
  return client;
}

async function rows(client: Client, query: InStatement) {
  return (await client.execute(query)).rows.map((row) => ({ ...row }));
}

/** The SQL blocks of each CONTRACT.md section whose heading matches, as validate.mjs reads them. */
function contractSql(heading: RegExp): string[] {
  return readFileSync('docs/CONTRACT.md', 'utf8')
    .replace(/\r\n/g, '\n')
    .split(/^(?=#{1,3} )/m)
    .filter((section) => heading.test(section))
    .map((section) => [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n'));
}

/** SQL without comments or layout; quoted text stays intact. */
function normalizeSql(sql: unknown): string {
  const tokens = String(sql).match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|(?:\s|--.*)+|[^\s'"-]+|-/g) ?? [];
  const space = (i: number) =>
    /[(),]$/.test(tokens[i - 1] ?? ',') || /^[(),]/.test(tokens[i + 1] ?? ',') ? '' : ' ';
  return tokens.map((token, i) => (/^(\s|--)/.test(token) ? space(i) : token)).join('');
}

/** One row per column, foreign key column and UNIQUE constraint of every table. */
const TABLE_PRAGMAS = [
  "SELECT m.name AS tbl, 'column' AS kind, p.* FROM sqlite_master m, pragma_table_info(m.name) p",
  "SELECT m.name AS tbl, 'foreign_key' AS kind, p.* FROM sqlite_master m, pragma_foreign_key_list(m.name) p",
  "SELECT m.name AS tbl, 'unique' AS kind, group_concat(i.name, ', ') AS columns FROM sqlite_master m, pragma_index_list(m.name) l, pragma_index_info(l.name) i WHERE l.origin = 'u' GROUP BY m.name, l.name",
];

/**
 * Every object but SQLite's own, keyed `<type> <name>`: its normalized SQL, which carries CHECKs and
 * partial-index filters, and for a table its TABLE_PRAGMAS rows (type, NOT NULL, default, key, actions).
 */
async function describeSchema(client: Client) {
  const schema: Record<string, string[]> = {};
  const objects = await rows(client, "SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
  for (const { type, name, sql } of objects) {
    schema[`${type} ${name}`] = [`sql ${normalizeSql(sql)}`];
  }
  for (const query of TABLE_PRAGMAS) {
    for (const { tbl, ...row } of await rows(client, query)) {
      schema[`table ${tbl}`]?.push(JSON.stringify(row));
    }
  }
  for (const lines of Object.values(schema)) lines.sort();
  return schema;
}

afterAll(() => {
  for (const client of clients) client.close();
});

describe('TEN-004: workspace migrations create exactly the CONTRACT.md §4.2 and §4.3 schema', () => {
  /** Every object of a database built from the §4.2 and §4.3 DDL in CONTRACT.md. */
  let contract: Record<string, string[]>;
  const migrated = memoryDatabase();
  const insert = (table: string, row: Record<string, string | number>) =>
    migrated.execute({
      sql: `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?')})`,
      args: Object.values(row),
    });
  /** A person party, a contact for it and a pitch to that contact, all with the id `id`. */
  const pitchTo = async (id: string) => {
    await insert('parties', { id, party_kind: 'person', display_name: id, ...STAMPS });
    await insert('contacts', { id, party_id: id, ...STAMPS });
    await insert('pitches', { id, contact_id: id, ...STAMPS });
  };

  beforeAll(async () => {
    const fromContract = memoryDatabase();
    await fromContract.executeMultiple(contractSql(/^### [\d.]+ Workspace database\b/).join('\n'));
    contract = await describeSchema(fromContract);
    expect(await applyWorkspaceMigrations(migrated)).toEqual({ applied: [1, 2, 3, 4], version: 4 });
  });

  it('holds every §4.2 and §4.3 object and no other', async () => {
    const names = (type: string) =>
      Object.keys(contract)
        .filter((key) => key.startsWith(`${type} `))
        .map((key) => key.slice(type.length + 1))
        .sort();
    expect(names('table').join(' ')).toBe(
      'agreements artist_aliases asset_credits assets audit_log catalog_search catalog_search_config catalog_search_content catalog_search_data catalog_search_docsize catalog_search_idx composition_alt_titles composition_assets composition_contributor_roles composition_contributors composition_registrations composition_terms compositions contact_methods contact_roles contacts external_references generated_report_items generated_reports import_issues import_runs licensing_contacts master_interests message_recipients messages metadata_terms organizations parties party_identifiers party_society_affiliations people pitch_events pitch_items pitches publishing_interests recording_artists recording_assets recording_contributors recording_links recording_registrations recording_terms recordings release_assets release_tracks releases report_templates schema_migrations workspace_self_parties workspace_settings',
    );
    expect(names('view')).toEqual([
      'composition_publishing_totals',
      'composition_writer_totals',
      'recording_master_totals',
    ]);
    expect(names('trigger')).toEqual([
      'audit_log_no_delete',
      'audit_log_no_update',
      'generated_report_items_no_delete',
      'generated_report_items_no_update',
      'generated_reports_no_delete',
      'generated_reports_no_update',
      'pitch_events_no_delete',
      'pitch_events_no_update',
      'pitch_items_one_level_composition',
      'pitch_items_one_level_recording',
      'pitch_items_target_immutable',
      'recordings_composition_change_pitch_level',
    ]);
    // 17 on §4.2 tables (version 1), 12 on version 2 tables, 13 on version 3 tables, 2 on version 4.
    expect(names('index')).toHaveLength(44);
    // Both ways, by name first: an object the migrations miss and an object the contract does not
    // declare each fail here. Then every object's SQL and pragma rows must match.
    const schema = await describeSchema(migrated);
    expect(Object.keys(schema).sort()).toEqual(Object.keys(contract).sort());
    expect(schema).toEqual(contract);
    // CREATE VIRTUAL TABLE catalog_search USING fts5 also creates FTS5's shadow tables. sqlite_master
    // lists them as tables, so both databases get them from that one statement and they are compared
    // like any table; their set and columns follow the fts5 arguments. This pins that they are FTS5's.
    const shadows = "SELECT name FROM pragma_table_list WHERE type = 'shadow' ORDER BY name";
    expect(await rows(migrated, shadows)).toEqual(
      ['config', 'content', 'data', 'docsize', 'idx'].map((s) => ({ name: `catalog_search_${s}` })),
    );
    // Fails with "foreign key mismatch" if a declared key has no PRIMARY KEY or UNIQUE parent.
    expect(await rows(migrated, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('records versions 1 to 4, and readSchemaVersion reads 4', async () => {
    const recorded = await rows(migrated, 'SELECT version, name FROM schema_migrations');
    expect(recorded).toEqual([
      { version: 1, name: 'parties_catalog' },
      { version: 2, name: 'assets_rights_audit_import_search' },
      { version: 3, name: 'crm_pitches_messages_reports' },
      { version: 4, name: 'registrations' },
    ]);
    expect(await readSchemaVersion(migrated)).toBe(4);
  });

  it.each<[string, string | RegExp, string]>([
    ['table contact_methods', /\s+label\s+TEXT,/, ''],
    ['table organizations', /legal_name(\s+)TEXT NOT NULL/, 'legal_name$1TEXT'],
    ['table artist_aliases', "DEFAULT 'stage_name'", "DEFAULT 'aka'"],
    ['table recordings', 'ON DELETE RESTRICT', 'ON DELETE CASCADE'],
    ['table people', /, party_kind\)( REFERENCES parties\(id), party_kind/, ')$1'],
    ['table composition_alt_titles', /,\s+UNIQUE \(composition_id, title\)/, ''],
    ['table compositions', "GLOB 'T", "GLOB 't"],
    ['index uq_recordings_isrc', ' AND deleted_at IS NULL', ''],
    ['index idx_recordings_title', /^[\s\S]*$/, 'SELECT 1'],
    [
      'table composition_contributors',
      /, party_kind\)( REFERENCES parties\(id), party_kind/,
      ')$1',
    ],
    ['table external_references', /,\s+UNIQUE \([^)]*\)/, ''],
    ['view composition_writer_totals', 'WHERE c.deleted_at IS NULL', ''],
    ['trigger audit_log_no_delete', 'BEFORE DELETE', 'AFTER DELETE'],
    ['table catalog_search', 'entity_id UNINDEXED', 'entity_id'],
    ['index idx_audit_time', ' DESC', ''],
    ['table contacts', /, organization_party_kind\)(\s+REFERENCES parties\(id), party_kind/, ')$1'],
    ['table workspace_settings', ' CHECK (id = 1)', ''],
    ['table messages', /,\s+CHECK \(status != 'sent' OR sent_at IS NOT NULL\)/, ''],
    ['index uq_pitch_items_recording', /\s+WHERE recording_id IS NOT NULL/, ''],
    ['trigger pitch_items_target_immutable', 'OF pitch_id, composition_id, recording_id ', ''],
    ['trigger recordings_composition_change_pitch_level', 'pc.composition_id', 'pc.recording_id'],
    ['trigger generated_reports_no_delete', 'is immutable', 'is append-only'],
  ])('reports a migration that alters %s', async (key, from, to) => {
    const migrations = readWorkspaceMigrations();
    const target = new RegExp(`${key.replace(/^\w+/, (type) => type.toUpperCase())}\\s`);
    const alteredMigrations = migrations.map((migration) => ({
      ...migration,
      statements: migration.statements.map((s) => (target.test(s) ? s.replace(from, to) : s)),
    }));
    expect(alteredMigrations).not.toEqual(migrations);
    const altered = memoryDatabase();
    await applyWorkspaceMigrations(altered, { migrations: alteredMigrations });
    const { [key]: changed, ...others } = await describeSchema(altered);
    const { [key]: original, ...expected } = contract;
    expect(others).toEqual(expected);
    expect(changed).not.toEqual(original);
  });

  it('refuses an organization party as a person and as the writer self party', async () => {
    await migrated.execute('PRAGMA foreign_keys = ON');
    const organization = { id: 'org', party_kind: 'organization', display_name: 'Org', ...STAMPS };
    await insert('parties', organization);
    await expect(insert('people', { party_id: 'org', legal_name: 'Org' })).rejects.toThrow(FK);
    const self = (side: string, party_kind: string) =>
      insert('workspace_self_parties', { side, party_id: 'org', party_kind, updated_at: AT });
    await expect(self('writer', 'person')).rejects.toThrow(FK);
    await expect(self('writer', 'organization')).rejects.toThrow(CHECK);
    await self('publishing', 'organization');
  });

  it.each([
    ['recordings', 'isrc', 'US-DMO-26-00001', 'USDMO2600001'],
    ['compositions', 'iswc', 'T-900.000.001-0', 'T9000000010'],
  ])('%s.%s refuses %s and accepts %s', async (table, column, formatted, normalized) => {
    const song = (value: string) =>
      insert(table, { id: value, title: 'Song', [column]: value, ...STAMPS });
    await expect(song(formatted)).rejects.toThrow(CHECK);
    await song(normalized);
  });

  it('counts only live compositions and recordings in the derived totals', async () => {
    await migrated.execute('PRAGMA foreign_keys = ON');
    await insert('parties', { id: 'pty', party_kind: 'person', display_name: 'Writer', ...STAMPS });
    for (const id of ['live', 'deleted']) {
      await insert('compositions', { id, title: id, ...STAMPS });
      await insert('recordings', { id, composition_id: id, title: id, ...STAMPS });
      const writer = { id, composition_id: id, party_id: 'pty', writer_share_bp: 6000 };
      await insert('composition_contributors', { ...writer, ...STAMPS });
      const publisher = { id, composition_id: id, publisher_party_id: 'pty', share_bp: 7000 };
      await insert('publishing_interests', { ...publisher, ...STAMPS });
      const owner = { id, recording_id: id, owner_party_id: 'pty', share_bp: 8000 };
      await insert('master_interests', { ...owner, ...STAMPS });
    }
    for (const table of ['compositions', 'recordings']) {
      await migrated.execute({
        sql: `UPDATE ${table} SET deleted_at = ? WHERE id = ?`,
        args: [AT, 'deleted'],
      });
    }
    const totals = (view: string, column: string) =>
      rows(migrated, `SELECT * FROM ${view} WHERE ${column} IN ('live', 'deleted')`);
    expect(await totals('composition_writer_totals', 'composition_id')).toEqual([
      { composition_id: 'live', writer_total_bp: 6000, writer_count: 1 },
    ]);
    expect(await totals('composition_publishing_totals', 'composition_id')).toEqual([
      { composition_id: 'live', territory: 'WORLD', publishing_total_bp: 7000, publisher_count: 1 },
    ]);
    expect(await totals('recording_master_totals', 'recording_id')).toEqual([
      { recording_id: 'live', master_total_bp: 8000, owner_count: 1 },
    ]);
  });

  it('refuses UPDATE and DELETE on audit_log', async () => {
    const entry = { id: 'aud', actor_type: 'system', action: 'workspace.created', occurred_at: AT };
    await insert('audit_log', { ...entry, entity_type: 'workspace', entity_id: 'ws' });
    const appendOnly = 'audit_log is append-only';
    await expect(migrated.execute("UPDATE audit_log SET action = 'x'")).rejects.toThrow(appendOnly);
    await expect(migrated.execute('DELETE FROM audit_log')).rejects.toThrow(appendOnly);
    expect(await rows(migrated, 'SELECT id, action FROM audit_log')).toEqual([
      { id: 'aud', action: 'workspace.created' },
    ]);
  });

  it('refuses a second external reference for a source record, target role and target key', async () => {
    const source = { source_system: 'csv', source_container: 'catalog.csv' };
    await insert('import_runs', {
      id: 'imp',
      ...source,
      mode: 'dry_run',
      source_snapshot_sha256: 'sha',
      full_snapshot: 0,
      status: 'succeeded',
      started_by: 'usr',
      started_at: AT,
    });
    const reference = (id: string, target_key: string) =>
      insert('external_references', {
        id,
        ...source,
        source_table: 'rows',
        source_record_id: 'row-1',
        target_role: 'writer_share',
        target_key,
        entity_type: 'composition_contributors',
        entity_id: `live|${target_key}`,
        source_payload_sha256: 'sha',
        applied_row_sha256: 'sha',
        first_import_run_id: 'imp',
        last_import_run_id: 'imp',
        last_applied_at: AT,
      });
    await reference('xref_1', 'pty_a');
    await reference('xref_2', 'pty_b');
    await expect(reference('xref_3', 'pty_a')).rejects.toThrow('UNIQUE constraint failed');
  });

  it('refuses a composition cell next to a cell for one of its recordings, in either order, and a new cell target', async () => {
    await migrated.execute('PRAGMA foreign_keys = ON');
    await insert('compositions', { id: 'cmp_song', title: 'Song', ...STAMPS });
    await insert('recordings', {
      id: 'rec_song',
      composition_id: 'cmp_song',
      title: 'Song',
      ...STAMPS,
    });
    const cell = (id: string, pitch_id: string, target: Record<string, string>) =>
      insert('pitch_items', { id, pitch_id, ...target, ...STAMPS });
    await pitchTo('pit_recording_first');
    await cell('pti_1', 'pit_recording_first', { recording_id: 'rec_song' });
    await expect(
      cell('pti_2', 'pit_recording_first', { composition_id: 'cmp_song' }),
    ).rejects.toThrow('pitch already holds a recording of this composition');
    await pitchTo('pit_composition_first');
    await cell('pti_3', 'pit_composition_first', { composition_id: 'cmp_song' });
    await expect(
      cell('pti_4', 'pit_composition_first', { recording_id: 'rec_song' }),
    ).rejects.toThrow('pitch already holds this song as a composition');
    for (const change of [
      "pitch_id = 'pit_composition_first'",
      "composition_id = 'cmp_song', recording_id = NULL",
    ]) {
      const retarget = migrated.execute(`UPDATE pitch_items SET ${change} WHERE id = 'pti_1'`);
      await expect(retarget).rejects.toThrow('pitch item target is immutable');
    }
    await migrated.execute("UPDATE pitch_items SET current_status = 'sent' WHERE id = 'pti_1'");
  });

  it('refuses moving a recording to a composition that a pitch holding the recording also holds', async () => {
    await migrated.execute('PRAGMA foreign_keys = ON');
    for (const id of ['cmp_from', 'cmp_held', 'cmp_free']) {
      await insert('compositions', { id, title: id, ...STAMPS });
    }
    await insert('recordings', {
      id: 'rec_moved',
      composition_id: 'cmp_from',
      title: 'Moved',
      ...STAMPS,
    });
    await pitchTo('pit_move');
    await insert('pitch_items', {
      id: 'pti_rec',
      pitch_id: 'pit_move',
      recording_id: 'rec_moved',
      ...STAMPS,
    });
    await insert('pitch_items', {
      id: 'pti_cmp',
      pitch_id: 'pit_move',
      composition_id: 'cmp_held',
      ...STAMPS,
    });
    const move = (composition: string) =>
      migrated.execute({
        sql: "UPDATE recordings SET composition_id = ? WHERE id = 'rec_moved'",
        args: [composition],
      });
    await expect(move('cmp_held')).rejects.toThrow(
      'pitch holds this recording and its new composition',
    );
    await move('cmp_free');
    expect(
      await rows(migrated, "SELECT composition_id FROM recordings WHERE id = 'rec_moved'"),
    ).toEqual([{ composition_id: 'cmp_free' }]);
  });

  it('refuses UPDATE and DELETE on pitch_events, generated_reports and generated_report_items', async () => {
    await migrated.execute('PRAGMA foreign_keys = ON');
    await pitchTo('pit_log');
    const event = { id: 'pev', pitch_id: 'pit_log', event_type: 'note_added', actor_type: 'user' };
    await insert('pitch_events', { ...event, occurred_at: AT });
    const template = {
      id: 'tpl',
      name: 'Full',
      report_type: 'metadata_package',
      config_json: '{}',
    };
    await insert('report_templates', { ...template, ...STAMPS });
    const report = {
      id: 'rpt',
      template_id: 'tpl',
      config_snapshot_json: '{}',
      content_json: '{}',
    };
    await insert('generated_reports', { ...report, content_text: 'Song', generated_at: AT });
    await insert('compositions', { id: 'cmp_report', title: 'Song', ...STAMPS });
    await insert('generated_report_items', {
      report_id: 'rpt',
      sort_order: 1,
      composition_id: 'cmp_report',
    });
    for (const [table, column, refusal] of [
      ['pitch_events', 'note', 'pitch_events is append-only'],
      ['generated_reports', 'content_text', 'generated_reports is immutable'],
      ['generated_report_items', 'sort_order', 'generated_report_items is immutable'],
    ]) {
      const update = `UPDATE ${table} SET ${column} = ${column}`;
      await expect(migrated.execute(update)).rejects.toThrow(refusal);
      await expect(migrated.execute(`DELETE FROM ${table}`)).rejects.toThrow(refusal);
      expect(await rows(migrated, `SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 1 }]);
    }
  });

  it('refuses a sent message without sent_at and an inbound message that is not received', async () => {
    const message = (id: string, row: Record<string, string>) =>
      insert('messages', { id, ...row, ...STAMPS });
    await expect(message('msg_1', { direction: 'outbound', status: 'sent' })).rejects.toThrow(
      CHECK,
    );
    await message('msg_2', { direction: 'outbound', status: 'sent', sent_at: AT });
    const received = { status: 'received', received_at: AT };
    await expect(message('msg_3', { direction: 'inbound', status: 'queued' })).rejects.toThrow(
      CHECK,
    );
    await expect(message('msg_4', { direction: 'outbound', ...received })).rejects.toThrow(CHECK);
    await message('msg_5', { direction: 'inbound', ...received });
  });

  it('refuses a second workspace_settings row and a follow_up_interval_days of 0', async () => {
    const settings = (row: Record<string, number>) =>
      insert('workspace_settings', { ...row, updated_at: AT });
    await expect(settings({ follow_up_interval_days: 0 })).rejects.toThrow(CHECK);
    await settings({});
    await expect(settings({})).rejects.toThrow(CHECK);
    await expect(settings({ id: 1 })).rejects.toThrow('UNIQUE constraint failed');
    expect(
      await rows(migrated, 'SELECT id, follow_up_interval_days FROM workspace_settings'),
    ).toEqual([{ id: 1, follow_up_interval_days: 7 }]);
  });
});

describe('U-08: catalog_search works in a local libSQL file', () => {
  it('returns an inserted row for a prefix MATCH built as §3.5 describes', async () => {
    // Removed before use and never after: Windows keeps a closed libSQL file locked.
    const file = 'data/test-workspace-schema-search.db';
    for (const suffix of ['', '-shm', '-wal']) rmSync(`${file}${suffix}`, { force: true });
    ensureLocalDatabaseDir(`file:./${file}`);
    const local = createClient({ url: `file:./${file}` });
    clients.push(local);
    expect(await applyWorkspaceMigrations(local)).toEqual({ applied: [1, 2, 3, 4], version: 4 });
    const row = ['composition', 'cmp_1', 'Ocean Blue', '', 'Northstar', 'Jordan Taylor', 'pop', ''];
    await local.execute({
      sql: 'INSERT INTO catalog_search (entity_type, entity_id, title, alt_titles, artist_names, contributor_names, terms, lyrics) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: row,
    });
    const search = (match: string) =>
      rows(local, {
        sql: 'SELECT entity_type, entity_id FROM catalog_search WHERE catalog_search MATCH ?',
        args: [match],
      });
    // §3.5 turns the text `Ocean Bl` into quoted tokens with `*` after the last closing quote.
    const found = [{ entity_type: 'composition', entity_id: 'cmp_1' }];
    expect(await search('"Ocean" "Bl"*')).toEqual(found);
    expect(await search('"Ocean" "Bl"')).toEqual([]);
  });
});
