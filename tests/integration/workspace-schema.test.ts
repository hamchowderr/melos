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

/** The §4.3 sections version 2 creates. CRM and Reports, with their guards and indexes, are 3. */
const VERSION_2_SECTIONS = /^-- -+ (Assets|Rights|Derived totals|Audit|Import|Search)\b/;

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
async function describeSchema(client: Client, include = (_: Record<string, unknown>) => true) {
  const schema: Record<string, string[]> = {};
  const objects = await rows(client, "SELECT * FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
  for (const { type, name, sql } of objects.filter(include)) {
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

describe('TEN-004: workspace migrations 1 and 2 create CONTRACT.md §4.2 and the first §4.3 objects', () => {
  /** The §4.2 objects and the version 2 §4.3 objects of a database built from the CONTRACT.md DDL. */
  let contract: Record<string, string[]>;
  const migrated = memoryDatabase();
  const insert = (table: string, row: Record<string, string | number>) =>
    migrated.execute({
      sql: `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?')})`,
      args: Object.values(row),
    });

  beforeAll(async () => {
    const [partiesCatalog, rest] = contractSql(/^### [\d.]+ Workspace database\b/);
    // §4.3 is one SQL block cut into sections by `-- ---------- <name>` comments.
    const sections = rest.split(/^(?=-- -{10} )/m);
    const version2 = sections.filter((section) => VERSION_2_SECTIONS.test(section));
    const fromContract = memoryDatabase();
    await fromContract.executeMultiple(partiesCatalog);
    const version1 = new Set(Object.keys(await describeSchema(fromContract)));
    await fromContract.executeMultiple(version2.join(''));
    const declared = new Set(Object.keys(await describeSchema(fromContract)));
    await fromContract.executeMultiple(sections.filter((s) => !version2.includes(s)).join(''));
    // Every workspace index and guard trigger sits at the end of §4.3. An index belongs to its table.
    // A trigger belongs to the version that creates the table it fires on, so
    // recordings_composition_change_pitch_level, which fires on a §4.2 table but reads pitch_items,
    // waits for version 3 with pitch_items.
    contract = await describeSchema(fromContract, ({ type, name, tbl_name }) => {
      const on = `table ${tbl_name}`;
      if (declared.has(`${type} ${name}`) || (type === 'index' && declared.has(on))) return true;
      return type === 'trigger' && declared.has(on) && !version1.has(on);
    });
    expect(await applyWorkspaceMigrations(migrated)).toEqual({ applied: [1, 2], version: 2 });
  });

  it('holds exactly the §4.2 objects, the version 2 §4.3 objects and their indexes', async () => {
    const names = (type: string) =>
      Object.keys(contract)
        .filter((key) => key.startsWith(`${type} `))
        .map((key) => key.slice(type.length + 1))
        .sort();
    expect(names('table').join(' ')).toBe(
      'agreements artist_aliases asset_credits assets audit_log catalog_search catalog_search_config catalog_search_content catalog_search_data catalog_search_docsize catalog_search_idx composition_alt_titles composition_assets composition_contributor_roles composition_contributors composition_terms compositions contact_methods external_references import_issues import_runs licensing_contacts master_interests metadata_terms organizations parties party_identifiers party_society_affiliations people publishing_interests recording_artists recording_assets recording_contributors recording_links recording_terms recordings release_assets release_tracks releases schema_migrations workspace_self_parties',
    );
    expect(names('view')).toEqual([
      'composition_publishing_totals',
      'composition_writer_totals',
      'recording_master_totals',
    ]);
    expect(names('trigger')).toEqual(['audit_log_no_delete', 'audit_log_no_update']);
    // 17 on §4.2 tables (version 1), 12 on version 2 tables.
    expect(names('index')).toHaveLength(29);
    expect(await describeSchema(migrated)).toEqual(contract);
    // CREATE VIRTUAL TABLE catalog_search USING fts5 also creates FTS5's shadow tables. sqlite_master
    // lists them as tables, so both databases get them from that one statement and they are compared
    // like any table; their set and columns follow the fts5 arguments. This pins that they are FTS5's.
    const shadows = "SELECT name FROM pragma_table_list WHERE type = 'shadow' ORDER BY name";
    expect(await rows(migrated, shadows)).toEqual(
      ['config', 'content', 'data', 'docsize', 'idx'].map((s) => ({ name: `catalog_search_${s}` })),
    );
  });

  it('records versions 1 and 2, and readSchemaVersion reads 2', async () => {
    const recorded = await rows(migrated, 'SELECT version, name FROM schema_migrations');
    expect(recorded).toEqual([
      { version: 1, name: 'parties_catalog' },
      { version: 2, name: 'assets_rights_audit_import_search' },
    ]);
    expect(await readSchemaVersion(migrated)).toBe(2);
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
});

describe('U-08: catalog_search works in a local libSQL file', () => {
  it('returns an inserted row for a prefix MATCH built as §3.5 describes', async () => {
    // Removed before use and never after: Windows keeps a closed libSQL file locked.
    const file = 'data/test-workspace-schema-search.db';
    for (const suffix of ['', '-shm', '-wal']) rmSync(`${file}${suffix}`, { force: true });
    ensureLocalDatabaseDir(`file:./${file}`);
    const local = createClient({ url: `file:./${file}` });
    clients.push(local);
    expect(await applyWorkspaceMigrations(local)).toEqual({ applied: [1, 2], version: 2 });
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
